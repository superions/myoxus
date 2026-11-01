//! P83 — Invariant-first integration tests: copilot domain.
//!
//! Each test maps directly to a named invariant from the copilot domain.
//!
//! Tests verify DB STATE after operations, not just HTTP / GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.
//!
//! GraphQL tests construct the app with Copilot enabled explicitly. Writing
//! `app_configs` after router construction without refreshing the runtime
//! overlay cannot affect that already-running test app.

use crate::helpers;

use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

#[tokio::test]
async fn inv_cp_prefill_is_connected_cancelable_and_provider_limits_stay_distinct() {
  use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::post,
  };
  use http_body_util::BodyExt;
  use std::sync::Arc;
  use tokio::sync::Notify;
  use tower::ServiceExt;
  let entered = Arc::new(Notify::new());
  let release = Arc::new(Notify::new());
  let handler_entered = entered.clone();
  let handler_release = release.clone();
  let provider = Router::new().route("/v1/chat/completions",post(move |Json(request): Json<serde_json::Value>| {
    let entered=handler_entered.clone(); let release=handler_release.clone();
    async move {
      match request["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap() {
        "prefill" => {entered.notify_one();release.notified().await;},
        "deadline" => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        "body-deadline" => {
          let frames=async_stream::stream! {
            yield Ok::<_,std::convert::Infallible>("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
          };
          return ([("content-type","text/event-stream")],Body::from_stream(frames)).into_response();
        },
        "context" => return (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"context_length_exceeded","message":"private-prompt-must-not-leak"}}))).into_response(),
        _ => {},
      }
      ([("content-type","text/event-stream")],"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n").into_response()
    }
  }));
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
  let server = tokio::spawn(async move {
    axum::serve(listener, provider).await.unwrap();
  });
  let mut config = myoxus_api::config::AppConfig::load().unwrap();
  config.copilot.enabled = true;
  config.copilot.default_provider = "fixture".into();
  config.copilot.fallback_providers.clear();
  config.copilot.providers.clear();
  config.copilot.providers.insert(
    "fixture".into(),
    serde_json::from_value(
      json!({"kind":"local","enabled":true,"endpoint":endpoint,"models":["fixture"],"timeout_ms":200}),
    )
    .unwrap(),
  );
  let mut registry = myoxus_application::copilot::provider::LlmProviderRegistry::new();
  registry.register(Arc::new(
    myoxus_infrastructure::copilot::openai_provider::OpenAiProvider::new(
      "fixture".into(),
      String::new(),
      endpoint,
      "fixture".into(),
      vec!["fixture".into()],
      Default::default(),
      std::time::Duration::from_millis(200),
      None,
    )
    .unwrap(),
  ));
  let state = myoxus_api::state::ApiState::new(config).with_llm_provider_registry(registry);
  let user = state
    .auth()
    .store
    .fulfill_user("prefill@example.test", None, None)
    .await
    .unwrap();
  let auth = state
    .auth()
    .create_user_session(
      user.id,
      myoxus_application::auth::SessionContext {
        user_agent: None,
        ip_address: None,
      },
    )
    .await
    .unwrap();
  let workspace = state
    .workspace()
    .create_workspace(user.id, Some("Prefill".into()), None)
    .await
    .unwrap();
  state
    .workspace()
    .update_workspace(
      workspace.id,
      myoxus_application::workspace::UpdateWorkspace {
        enable_ai: Some(true),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let copilot = state.copilot();
  let app = myoxus_api::build_router_for_integration_tests(state);
  for (input, code) in [
    ("prefill", ""),
    ("deadline", "COPILOT_PROVIDER_TIMEOUT"),
    ("body-deadline", "COPILOT_PROVIDER_TIMEOUT"),
    ("context", "COPILOT_CONTEXT_LIMIT"),
    ("truncated", "COPILOT_OUTPUT_TRUNCATED"),
  ] {
    let session = copilot
      .create_session(user.id, Some(workspace.id), None, None, None, json!({}))
      .await
      .unwrap();
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/copilot/chat/{}/stream-object?message={input}&toolsConfig=%7B%22searchWorkspace%22%3Afalse%7D",
            session.id
          ))
          .header("cookie", format!("affine_session={}", auth.id))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let mut body = response.into_body();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(
      std::str::from_utf8(&first).unwrap().contains(": connected"),
      "headers/connection must precede upstream prefill"
    );
    if input == "prefill" {
      let reading = tokio::spawn(async move {
        body.frame().await;
        body
      });
      tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
      reading.abort();
      assert!(reading.await.unwrap_err().is_cancelled());
      release.notify_one();
      tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
          let messages = copilot.list_messages(session.id, 10, 0).await.unwrap();
          if messages.last().unwrap().token_usage.as_ref().unwrap()["streamStatus"] == "canceled" {
            break;
          }
          tokio::task::yield_now().await;
        }
      })
      .await
      .expect("prefill disconnect releases durable running state");
    } else {
      let bytes = tokio::time::timeout(std::time::Duration::from_secs(1), body.collect())
        .await
        .expect("configured provider deadline, not restarted HTTP retry timers")
        .unwrap()
        .to_bytes();
      let wire = String::from_utf8(bytes.to_vec()).unwrap();
      assert!(wire.contains(code), "{wire}");
      assert!(!wire.contains("event: done"));
      assert!(!wire.contains("private-prompt"));
      let messages = copilot.list_messages(session.id, 10, 0).await.unwrap();
      let assistant = messages.last().unwrap();
      assert_eq!(assistant.token_usage.as_ref().unwrap()["streamStatus"], "failed");
      assert_eq!(
        assistant.content["text"],
        if matches!(input, "truncated" | "body-deadline") {
          "partial"
        } else {
          ""
        }
      );
    }
  }
  server.abort();
}

/// Provider fallback translates explicit intent, never drops it on an endpoint
/// without a control. Inspect real HTTP bodies after authenticated SSE ingress.
#[tokio::test]
async fn inv_cp_reasoning_control_reaches_wire_and_survives_fallback() {
  use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    routing::post,
  };
  use http_body_util::BodyExt;
  use std::sync::{Arc, Mutex};
  use tower::ServiceExt;
  let captured = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
  let mut provider = Router::new();
  for name in ["primary", "unsupported", "backup"] {
    let captured = captured.clone();
    provider = provider.route(
      &format!("/{name}/chat/completions"),
      post(move |Json(body): Json<serde_json::Value>| {
        let captured = captured.clone();
        async move {
          captured.lock().unwrap().push((name.into(), body));
          (
            if name == "backup" {
              StatusCode::OK
            } else {
              StatusCode::INTERNAL_SERVER_ERROR
            },
            [("content-type", "text/event-stream")],
            "data: {\"choices\":[{\"delta\":{\"content\":\"42\"}}]}\n\ndata: [DONE]\n\n",
          )
        }
      }),
    );
  }
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let origin = format!("http://{}", listener.local_addr().unwrap());
  let server = tokio::spawn(async move {
    axum::serve(listener, provider).await.unwrap();
  });
  let mut config = myoxus_api::config::AppConfig::load().unwrap();
  config.copilot.enabled = true;
  config.copilot.default_provider = "primary".into();
  config.copilot.fallback_providers = vec!["unsupported".into(), "backup".into()];
  config.copilot.providers.clear();
  let mut registry = myoxus_application::copilot::provider::LlmProviderRegistry::new();
  for name in ["primary", "unsupported", "backup"] {
    let options = match name {
      "primary" => json!({"reasoning.v1/model":{"reasoning_control":{"type":"enable_thinking"}}}),
      "backup" => {
        json!({"reasoning.v1/model":{"reasoning_control":{"type":"reasoning_effort","on":"medium","off":"low"}}})
      }
      _ => json!({}),
    };
    let provider: myoxus_api::config::CopilotProviderConfig = serde_json::from_value(json!({"enabled":true,"kind":"local","endpoint":format!("{origin}/{name}"),"models":["reasoning.v1/model","plain"],"model_options":options})).unwrap();
    registry.register(Arc::new(
      myoxus_infrastructure::copilot::openai_provider::OpenAiProvider::new(
        name.into(),
        String::new(),
        provider.endpoint.clone().unwrap(),
        "reasoning.v1/model".into(),
        provider.models.clone(),
        provider.model_options.clone(),
        std::time::Duration::from_secs(5),
        None,
      )
      .unwrap(),
    ));
    config.copilot.providers.insert(name.into(), provider);
  }
  let state = myoxus_api::state::ApiState::new(config).with_llm_provider_registry(registry);
  let user = state
    .auth()
    .store
    .fulfill_user("reasoning-wire@example.test", None, None)
    .await
    .unwrap();
  let auth = state
    .auth()
    .create_user_session(
      user.id,
      myoxus_application::auth::SessionContext {
        user_agent: None,
        ip_address: None,
      },
    )
    .await
    .unwrap();
  let workspace = state
    .workspace()
    .create_workspace(user.id, Some("Reasoning wire".into()), None)
    .await
    .unwrap();
  state
    .workspace()
    .update_workspace(
      workspace.id,
      myoxus_application::workspace::UpdateWorkspace {
        enable_ai: Some(true),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let session = state
    .copilot()
    .create_session(user.id, Some(workspace.id), None, None, None, json!({}))
    .await
    .unwrap();
  let app = myoxus_api::build_router_for_integration_tests(state);
  let response = app.clone().oneshot(Request::builder().method("POST").uri("/graphql")
    .header("cookie",format!("affine_session={}",auth.id)).header("content-type","application/json")
    .body(Body::from(json!({"query":"{currentUser{copilot{models(promptName:\"Chat With Myoxus AI\"){optionalModels{id reasoningAvailable}}}}}"}).to_string())).unwrap()).await.unwrap();
  let response: serde_json::Value =
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
  assert!(response.get("errors").is_none(), "{response}");
  assert_eq!(
    response["data"]["currentUser"]["copilot"]["models"]["optionalModels"],
    json!([
      {"id":"reasoning.v1/model","reasoningAvailable":true}, {"id":"plain","reasoningAvailable":false}
    ])
  );
  for (query, expected_thinking, expected_effort) in [
    ("reasoning=true", Some(true), Some("medium")),
    ("reasoning=false", Some(false), Some("low")),
    ("", None, None),
  ] {
    captured.lock().unwrap().clear();
    let response = app.clone().oneshot(Request::builder().uri(format!("/api/copilot/chat/{}/stream-object?message=wire-check&modelId=reasoning.v1%2Fmodel&toolsConfig=%7B%22searchWorkspace%22%3Afalse%7D&{query}",session.id))
      .header("cookie",format!("affine_session={}",auth.id)).body(Body::empty()).unwrap()).await.unwrap();
    let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("event: done"), "{wire}");
    let requests = captured.lock().unwrap();
    assert_eq!(
      requests.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
      if expected_thinking.is_some() {
        vec!["primary", "backup"]
      } else {
        vec!["primary", "unsupported", "backup"]
      }
    );
    for (name, body) in requests.iter() {
      assert_eq!(body["model"], "reasoning.v1/model");
      assert_eq!(body["stream"], true);
      if name == "primary" && expected_thinking.is_some() {
        assert_eq!(
          body["chat_template_kwargs"]["enable_thinking"],
          json!(expected_thinking.unwrap())
        );
        assert!(body.get("reasoning_effort").is_none());
      } else if name == "backup" && expected_effort.is_some() {
        assert_eq!(body["reasoning_effort"], json!(expected_effort.unwrap()));
        assert!(body.get("chat_template_kwargs").is_none());
      } else {
        assert!(body.get("chat_template_kwargs").is_none());
        assert!(body.get("reasoning_effort").is_none());
      }
    }
  }
  server.abort();
}

/// Exercise the served SSE payload against the chat renderer's discriminated
/// stream-object contract, then check durable objects, history and terminal state.
#[tokio::test]
async fn inv_cp_stream_objects_render_and_preserve_text() {
  use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
  };

  use async_trait::async_trait;
  use axum::{body::Body, http::Request};
  use http_body_util::BodyExt;
  use myoxus_application::{
    auth::SessionContext,
    copilot::provider::{
      LlmFinishReason, LlmModelInfo, LlmProvider, LlmProviderError, LlmProviderRegistry, LlmRequest, LlmResponse,
      LlmStreamEvent, LlmTokenStream,
    },
    workspace::UpdateWorkspace,
  };
  use serde::Deserialize;
  use tower::ServiceExt;

  const CHUNKS: [&str; 3] = ["MYOXUS-COPILOT-OK: 55", "\n", "Grüße, \"Qwen\" \\ done"];

  struct StreamingProvider(Arc<AtomicUsize>);
  #[async_trait]
  impl LlmProvider for StreamingProvider {
    fn provider_id(&self) -> &str {
      "fixture"
    }
    async fn list_models(&self) -> Result<Vec<LlmModelInfo>, LlmProviderError> {
      Ok(Vec::new())
    }
    async fn complete(&self, _: &LlmRequest) -> Result<LlmResponse, LlmProviderError> {
      panic!("the consuming route must use the streaming provider")
    }
    async fn stream_chat(&self, request: &LlmRequest) -> Result<LlmTokenStream, LlmProviderError> {
      let call = self.0.fetch_add(1, Ordering::SeqCst);
      assert_eq!(
        request.model,
        if call == 0 || call == 2 {
          "fixture.v2/model"
        } else {
          "fixture-model"
        },
        "native and deployed-alias selections must reach the provider literally"
      );
      assert!(
        request.tools.is_empty(),
        "configured executors are not a native tool continuation loop"
      );
      if request.messages.last().unwrap().content.as_text() == Some("tool-only stream contract") {
        return Ok(Box::pin(futures_util::stream::iter([Ok(LlmStreamEvent::Finish(
          LlmFinishReason::ToolCalls,
        ))])));
      }
      assert_eq!(
        request.messages.last().unwrap().content.as_text(),
        Some("synthetic stream contract")
      );
      Ok(Box::pin(futures_util::stream::iter(
        std::iter::once(Ok(LlmStreamEvent::Reasoning("provider reasoning 🦔".into())))
          .chain(CHUNKS.into_iter().map(|text| Ok(LlmStreamEvent::Text(text.to_owned()))))
          .chain(std::iter::once(Ok(LlmStreamEvent::Finish(LlmFinishReason::Stop)))),
      )))
    }
  }

  // This is the existing frontend StreamObjectSchema text variant, not the
  // server's former type=message/content envelope.
  #[derive(Deserialize)]
  #[serde(tag = "type")]
  enum ClientStreamObject {
    #[serde(rename = "text-delta")]
    TextDelta {
      #[serde(rename = "textDelta")]
      text: String,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
      #[serde(rename = "textDelta")]
      text: String,
    },
  }

  let mut config = myoxus_api::config::AppConfig::load().unwrap();
  config.copilot.enabled = true;
  config.copilot.default_provider = "fixture".into();
  config.copilot.fallback_providers.clear();
  config.copilot.providers.clear();
  config.copilot.providers.insert(
    "fixture".into(),
    serde_json::from_value(json!({"enabled":true,"kind":"local","models":["fixture-model","fixture.v2/model"]}))
      .unwrap(),
  );
  config.copilot.providers.insert(
    "disabled".into(),
    serde_json::from_value(json!({"enabled":false,"kind":"local","models":["disabled-model"]})).unwrap(),
  );
  config.copilot.exa.key = Some("unused-executor-fixture".into());
  let mut registry = LlmProviderRegistry::new();
  let provider_calls = Arc::new(AtomicUsize::new(0));
  registry.register(Arc::new(StreamingProvider(provider_calls.clone())));
  let state = myoxus_api::state::ApiState::new(config).with_llm_provider_registry(registry);
  let user = state
    .auth()
    .store
    .fulfill_user("copilot-stream@example.test", None, None)
    .await
    .unwrap();
  let auth = state
    .auth()
    .create_user_session(
      user.id,
      SessionContext {
        user_agent: None,
        ip_address: None,
      },
    )
    .await
    .unwrap();
  let copilot = state.copilot();
  let workspace_service = state.workspace().clone();
  let workspace = workspace_service
    .create_workspace(user.id, Some("Copilot stream".into()), None)
    .await
    .unwrap();
  workspace_service
    .update_workspace(
      workspace.id,
      UpdateWorkspace {
        enable_ai: Some(true),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  let session = copilot
    .create_session(
      user.id,
      Some(workspace.id),
      None,
      None,
      Some("fixture-model".into()),
      json!({}),
    )
    .await
    .unwrap();
  let app = myoxus_api::build_router_for_integration_tests(state);
  for query in [
    "reasoning=false",
    "reasoning=true",
    "modelId=unconfigured",
    "modelId=disabled-model",
    "modelId=fixture.v2%2Fmodel&model=fixture-model",
  ] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/copilot/chat/{}/stream-object?message=must-not-append&{query}",
            session.id
          ))
          .header("cookie", format!("affine_session={}", auth.id))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("COPILOT_SESSION_INVALID_INPUT"), "{wire}");
    assert!(!wire.contains("event: done\n"));
    assert!(copilot.list_messages(session.id, 10, 0).await.unwrap().is_empty());
    assert_eq!(provider_calls.load(Ordering::SeqCst), 0);
  }
  let model_query = json!({"query":"{currentUser{copilot{models(promptName:\"Chat With Myoxus AI\"){defaultModel optionalModels{id name} proModels{id}}}}}"});
  let model_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("cookie", format!("affine_session={}", auth.id))
        .header("content-type", "application/json")
        .body(Body::from(model_query.to_string()))
        .unwrap(),
    )
    .await
    .unwrap();
  let model_response: serde_json::Value =
    serde_json::from_slice(&model_response.into_body().collect().await.unwrap().to_bytes()).unwrap();
  assert!(model_response.get("errors").is_none(), "{model_response}");
  assert_eq!(
    model_response["data"]["currentUser"]["copilot"]["models"],
    json!({"defaultModel":"fixture-model","optionalModels":[{"id":"fixture-model","name":"fixture-model"},{"id":"fixture.v2/model","name":"fixture.v2/model"}],"proModels":[]})
  );
  let user_turn = copilot
    .submit_user_message(
      user.id,
      session.id,
      json!({"text":"synthetic stream contract"}),
      None,
      Vec::new(),
      Some("claim-initial".into()),
    )
    .await
    .unwrap();
  let initial_uri = format!(
    "/api/copilot/chat/{}/stream-object?messageId={}&requestId=claim-initial&modelId=fixture.v2%2Fmodel&model=fixture.v2%2Fmodel",
    session.id, user_turn.id
  );
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&initial_uri)
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), 200);
  assert!(
    response.headers()["content-type"]
      .to_str()
      .unwrap()
      .contains("text/event-stream")
  );
  let in_progress = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&initial_uri)
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let (bytes, replayed) = tokio::join!(response.into_body().collect(), in_progress.into_body().collect());
  let replayed = String::from_utf8(replayed.unwrap().to_bytes().to_vec()).unwrap();
  assert!(
    replayed.contains("event: done\n") && replayed.contains("provider reasoning"),
    "an in-progress replay follows the existing response: {replayed}"
  );
  let bytes = bytes.unwrap().to_bytes();
  let wire = String::from_utf8(bytes.to_vec()).unwrap();
  let mut rendered = String::new();
  let mut message_events = 0;
  let mut reasoning = String::new();
  for event in wire.split("\n\n").filter(|event| event.starts_with("event: message\n")) {
    let data = event
      .lines()
      .filter_map(|line| line.strip_prefix("data: "))
      .collect::<Vec<_>>()
      .join("\n");
    match serde_json::from_str(&data)
      .expect("SSE message data must satisfy the native chat renderer's stream-object schema")
    {
      ClientStreamObject::TextDelta { text } => rendered.push_str(&text),
      ClientStreamObject::Reasoning { text } => reasoning.push_str(&text),
    }
    message_events += 1;
  }
  assert_eq!(
    message_events,
    CHUNKS.len() + 1,
    "each provider chunk must reach the client: {wire}"
  );
  assert_eq!(rendered, CHUNKS.concat());
  assert_eq!(reasoning, "provider reasoning 🦔");
  assert!(wire.contains("event: done\n"));
  let messages = copilot.list_messages(session.id, 10, 0).await.unwrap();
  assert_eq!(messages.len(), 2);
  assert_eq!(messages[0].content["text"], "synthetic stream contract");
  assert_eq!(messages[1].content["text"], CHUNKS.concat());
  assert_eq!(messages[1].token_usage.as_ref().unwrap()["streamStatus"], "done");
  let original_stream = messages[1].token_usage.as_ref().unwrap()["streamId"]
    .as_str()
    .unwrap()
    .to_owned();
  let replay = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&initial_uri)
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let replay = String::from_utf8(replay.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(
    replay.contains("event: done\n") && replay.contains("provider reasoning"),
    "{replay}"
  );
  assert_eq!(
    provider_calls.load(Ordering::SeqCst),
    1,
    "transport replay never invokes generation again"
  );
  assert_eq!(copilot.list_messages(session.id, 10, 0).await.unwrap().len(), 2);
  assert_eq!(
    messages[1].content["streamObjects"],
    json!([
      {"type":"reasoning","textDelta":reasoning}, {"type":"text-delta","textDelta":rendered}
    ])
  );
  assert!(
    copilot
      .list_message_revisions(messages[1].id, 10, 0)
      .await
      .unwrap()
      .is_empty()
  );
  let history_request = json!({"query":"query($w:String!,$s:String!){currentUser{copilot(workspaceId:$w){chats(pagination:{first:1},options:{sessionId:$s}){edges{node{messages{content streamObjects{type textDelta}}}}}}}}", "variables":{"w":workspace.id.to_string(),"s":session.id.to_string()}});
  let history = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("cookie", format!("affine_session={}", auth.id))
        .header("content-type", "application/json")
        .body(Body::from(history_request.to_string()))
        .unwrap(),
    )
    .await
    .unwrap();
  let history: serde_json::Value =
    serde_json::from_slice(&history.into_body().collect().await.unwrap().to_bytes()).unwrap();
  assert!(history.get("errors").is_none(), "{history}");
  let projected = &history["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"][1];
  assert_eq!(projected["content"], CHUNKS.concat());
  assert_eq!(projected["streamObjects"][0]["textDelta"], "provider reasoning 🦔");
  assert_eq!(
    projected["streamObjects"][1]["textDelta"],
    CHUNKS.concat(),
    "history must not hide the answer behind reasoning"
  );

  let tool_session = copilot
    .create_session(user.id, Some(workspace.id), None, None, None, json!({}))
    .await
    .unwrap();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(format!(
          "/api/copilot/chat/{}/stream-object?message=tool-only%20stream%20contract",
          tool_session.id
        ))
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let failed_wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(failed_wire.contains("NO_COPILOT_PROVIDER_AVAILABLE"), "{failed_wire}");
  assert!(
    !failed_wire.contains("event: done\n"),
    "tool-only output must not become an empty successful answer"
  );
  assert_eq!(
    copilot.list_messages(tool_session.id, 10, 0).await.unwrap()[1]
      .token_usage
      .as_ref()
      .unwrap()["streamStatus"],
    "failed"
  );

  for polled in [false, true] {
    let model_query = if polled {
      "model=fixture.v2%2Fmodel"
    } else {
      "model=fixture-model"
    };
    let canceled = copilot
      .create_session(user.id, Some(workspace.id), None, None, None, json!({}))
      .await
      .unwrap();
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/copilot/chat/{}/stream-object?message=synthetic%20stream%20contract&{model_query}",
            canceled.id
          ))
          .header("cookie", format!("affine_session={}", auth.id))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let mut body = response.into_body();
    if polled {
      let connected = body.frame().await.unwrap().unwrap().into_data().unwrap();
      assert!(std::str::from_utf8(&connected).unwrap().contains(": connected"));
      let retrieval = body.frame().await.unwrap().unwrap().into_data().unwrap();
      let retrieval = std::str::from_utf8(&retrieval).unwrap();
      assert!(
        retrieval.contains("event: retrieval-status") && retrieval.contains("\"available\":false"),
        "{retrieval}"
      );
      let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
      assert!(std::str::from_utf8(&first).unwrap().contains("reasoning"));
    }
    drop(body);
    let partial = tokio::time::timeout(std::time::Duration::from_secs(5), async {
      loop {
        let message = copilot.list_messages(canceled.id, 10, 0).await.unwrap().pop().unwrap();
        if message.token_usage.as_ref().unwrap()["streamStatus"] == "canceled" {
          break message;
        }
        tokio::task::yield_now().await;
      }
    })
    .await
    .expect("disconnect finalization must finish");
    assert_eq!(
      partial.content["streamObjects"],
      if polled {
        json!([{"type":"reasoning","textDelta":"provider reasoning 🦔"}])
      } else {
        json!([])
      }
    );
    let stream_id = partial.token_usage.as_ref().unwrap()["streamId"]
      .as_str()
      .unwrap()
      .parse()
      .unwrap();
    assert!(copilot.stream_snapshot(stream_id).await.unwrap().is_none());
  }

  // Reject a stale generated write through the real consuming route, not just
  // the repository contract. Storage rejection must never emit successful done.
  let rejected = copilot
    .create_session(user.id, Some(workspace.id), None, None, None, json!({}))
    .await
    .unwrap();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(format!(
          "/api/copilot/chat/{}/stream-object?message=synthetic%20stream%20contract",
          rejected.id
        ))
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let mut body = response.into_body();
  let connected = body.frame().await.unwrap().unwrap().into_data().unwrap();
  assert!(std::str::from_utf8(&connected).unwrap().contains(": connected"));
  let retrieval = body.frame().await.unwrap().unwrap().into_data().unwrap();
  let retrieval = std::str::from_utf8(&retrieval).unwrap();
  assert!(
    retrieval.contains("event: retrieval-status") && retrieval.contains("\"available\":false"),
    "{retrieval}"
  );
  let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
  assert!(std::str::from_utf8(&first).unwrap().contains("reasoning"));
  let assistant = copilot.list_messages(rejected.id, 10, 0).await.unwrap().pop().unwrap();
  copilot
    .edit_message(assistant.id, json!({"text":"manual edit wins"}))
    .await
    .unwrap();
  let wire = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(wire.contains("event: error\n"), "{wire}");
  assert!(
    !wire.contains("event: done\n"),
    "a rejected storage write is not success"
  );
  assert_eq!(
    copilot
      .list_messages(rejected.id, 10, 0)
      .await
      .unwrap()
      .pop()
      .unwrap()
      .content["text"],
    "manual edit wins"
  );

  let regenerate = format!(
    "/api/copilot/chat/{}/stream-object?messageId={}&responseId={}&expectedStreamId={}&requestId=retry-last&modelId=fixture-model",
    session.id, user_turn.id, messages[1].id, original_stream
  );
  for _ in 0..2 {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(&regenerate)
          .header("cookie", format!("affine_session={}", auth.id))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("event: done\n"), "{wire}");
  }
  let regenerated = copilot.list_messages(session.id, 10, 0).await.unwrap();
  assert_eq!(regenerated.len(), 2);
  assert_eq!(regenerated[1].id, messages[1].id);
  let revisions = copilot.list_message_revisions(messages[1].id, 10, 0).await.unwrap();
  assert_eq!(revisions.len(), 1);
  assert_eq!(revisions[0].content, messages[1].content);
  let stale = regenerate.replace("requestId=retry-last", "requestId=stale-regenerate");
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(stale)
        .header("cookie", format!("affine_session={}", auth.id))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
  assert!(
    wire.contains("COPILOT_SESSION_INVALID_INPUT") && !wire.contains("event: done\n"),
    "{wire}"
  );
  assert_eq!(
    provider_calls.load(Ordering::SeqCst),
    5,
    "one explicit regeneration, no replay/stale generation"
  );

  // A durable session ID is not continuing authority to send prompts. These
  // denied requests must not append a user turn or reach the provider.
  workspace_service
    .update_workspace(
      workspace.id,
      UpdateWorkspace {
        enable_ai: Some(false),
        ..Default::default()
      },
    )
    .await
    .unwrap();
  for deleted in [false, true] {
    if deleted {
      workspace_service
        .update_workspace(
          workspace.id,
          UpdateWorkspace {
            enable_ai: Some(true),
            ..Default::default()
          },
        )
        .await
        .unwrap();
      copilot.delete_session(session.id).await.unwrap();
    }
    let before = copilot.list_messages(session.id, 10, 0).await.unwrap().len();
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/copilot/chat/{}/stream-object?message=must-not-be-sent",
            session.id
          ))
          .header("cookie", format!("affine_session={}", auth.id))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    let wire = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(wire.contains("COPILOT_ACCESS_DENIED"), "{wire}");
    assert!(!wire.contains("event: done\n"), "{wire}");
    assert_eq!(provider_calls.load(Ordering::SeqCst), 5);
    assert_eq!(copilot.list_messages(session.id, 10, 0).await.unwrap().len(), before);
  }
}

// ---------------------------------------------------------------------------
// INV-CP-01 — createCopilotSession persists a row with correct workspace_id,
//             user_id, and pinned = false by default
//
// Goes through the real GraphQL path with copilot temporarily enabled in DB.
// The test enables copilot, calls the mutation, disables copilot, then asserts
// DB state. The session row must have the correct owner, workspace, and defaults.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp01_session_created_in_db() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "inv_cp01").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let resp = helpers::gql(
    &app,
    user_session,
    json!({
      "query": "mutation CS($opts: CreateChatSessionInput!) { createCopilotSession(options: $opts) }",
      "variables": { "opts": { "workspaceId": workspace_id.to_string(), "promptName": "chat-with-ai" } }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_none(),
    "INV-CP-01: createCopilotSession failed: {resp}"
  );
  let session_id: Uuid = resp["data"]["createCopilotSession"]
    .as_str()
    .expect("session id")
    .parse()
    .expect("valid UUID");

  // Assert: copilot_sessions row exists with correct user_id, workspace_id, pinned = false
  let row = sqlx::query("SELECT user_id, workspace_id, pinned FROM copilot_sessions WHERE id = $1")
    .bind(session_id)
    .fetch_optional(&pool)
    .await
    .expect("copilot_sessions query");

  assert!(
    row.is_some(),
    "INV-CP-01: copilot_sessions must have row for created session {session_id}"
  );
  let row = row.expect("copilot db row must exist");
  assert_eq!(
    row.get::<Uuid, _>("user_id"),
    user_id,
    "INV-CP-01: copilot_sessions.user_id must match authenticated user"
  );
  assert_eq!(
    row.get::<Option<Uuid>, _>("workspace_id"),
    Some(workspace_id),
    "INV-CP-01: copilot_sessions.workspace_id must match requested workspace"
  );
  assert!(
    !row.get::<bool, _>("pinned"),
    "INV-CP-01: copilot_sessions.pinned must default to false"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-CP-02 — cleanupCopilotSession sets deleted_at (soft-delete)
//
// Uses direct SQL insert for the session to avoid the `copilot.enabled` gate,
// then calls cleanupCopilotSession via GraphQL (which does NOT check the
// copilot-enabled flag at the DB write layer — only at the session-access
// layer which we bypass by inserting the session directly).
//
// Because the cleanup GraphQL call also gates on copilot.enabled, we enable
// it, call the mutation, disable it, and then verify the DB state. The enable
// and disable happen in the same goroutine and are bracketed around the call.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp02_deleted_session_marked_deleted() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "inv_cp02").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Insert copilot session directly (bypasses copilot.enabled gate)
  let session_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO copilot_sessions (id, user_id, workspace_id, title, model, pinned)
     VALUES ($1, $2, $3, 'INV-CP-02', 'test-model', false)",
  )
  .bind(session_id)
  .bind(user_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("insert copilot session");

  // Precondition: deleted_at is NULL
  let before: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM copilot_sessions WHERE id = $1")
      .bind(session_id)
      .fetch_optional(&pool)
      .await
      .expect("pre-cleanup query")
      .flatten();
  assert!(
    before.is_none(),
    "INV-CP-02 pre: deleted_at must be NULL before cleanup"
  );

  let cleanup_resp = helpers::gql(
    &app,
    user_session,
    json!({
      "query": "mutation CC($opts: DeleteSessionInput!) { cleanupCopilotSession(options: $opts) }",
      "variables": { "opts": { "workspaceId": workspace_id.to_string(), "sessionIds": [session_id.to_string()] } }
    }),
  )
  .await;

  assert!(
    cleanup_resp.get("errors").is_none(),
    "INV-CP-02: cleanupCopilotSession failed: {cleanup_resp}"
  );

  // Assert: deleted_at IS NOT NULL (soft-delete, row still present)
  let after: Option<chrono::DateTime<chrono::Utc>> =
    sqlx::query_scalar("SELECT deleted_at FROM copilot_sessions WHERE id = $1")
      .bind(session_id)
      .fetch_optional(&pool)
      .await
      .expect("post-cleanup query")
      .flatten();
  assert!(
    after.is_some(),
    "INV-CP-02: copilot_sessions.deleted_at must be set after cleanupCopilotSession — soft-delete invariant broken"
  );

  for payload in [
    json!({"query":"mutation($options:CreateChatMessageInput!){createCopilotMessage(options:$options)}", "variables":{"options":{"sessionId":session_id,"content":"must not append"}}}),
    json!({"query":"mutation($options:UpdateChatSessionInput!){updateCopilotSession(options:$options)}", "variables":{"options":{"sessionId":session_id,"pinned":true}}}),
    json!({"query":"mutation($options:ForkChatSessionInput!){forkCopilotSession(options:$options)}", "variables":{"options":{"sessionId":session_id,"workspaceId":workspace_id,"docId":""}}}),
  ] {
    let denied = helpers::gql(&app, user_session, payload).await;
    assert_eq!(denied["errors"][0]["extensions"]["code"], "FORBIDDEN", "{denied}");
  }
  let message_count: i64 = sqlx::query_scalar("SELECT count(*) FROM copilot_messages WHERE session_id = $1")
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .expect("deleted session message count");
  assert_eq!(message_count, 0, "deleted sessions cannot accept another turn");

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-CP-03 — createCopilotMessage persists a row in copilot_messages
//
// Inserts session directly via SQL, then calls createCopilotMessage via
// GraphQL (which checks copilot.enabled per workspace access). Enables
// copilot for the duration of the mutation call only.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cp03_message_appended_to_session() {
  let (app, pool, auth_store) = helpers::setup_app_with_copilot_enabled().await;
  let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "inv_cp03").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  // Insert copilot session directly
  let session_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO copilot_sessions (id, user_id, workspace_id, title, model, pinned)
     VALUES ($1, $2, $3, 'INV-CP-03', 'test-model', false)",
  )
  .bind(session_id)
  .bind(user_id)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("insert copilot session");

  let msg_resp = helpers::gql(
    &app,
    user_session,
    json!({
      "query": "mutation CM($opts: CreateChatMessageInput!) { createCopilotMessage(options: $opts) }",
      "variables": { "opts": { "sessionId": session_id.to_string(), "content": "hello invariant" } }
    }),
  )
  .await;

  assert!(
    msg_resp.get("errors").is_none(),
    "INV-CP-03: createCopilotMessage failed: {msg_resp}"
  );
  let msg_id: Uuid = msg_resp["data"]["createCopilotMessage"]
    .as_str()
    .expect("message id")
    .parse()
    .expect("valid UUID");

  // Assert: copilot_messages row exists with correct session_id and role = 'user'
  let row = sqlx::query("SELECT session_id, role FROM copilot_messages WHERE id = $1")
    .bind(msg_id)
    .fetch_optional(&pool)
    .await
    .expect("copilot_messages query");

  assert!(
    row.is_some(),
    "INV-CP-03: copilot_messages must have row for created message {msg_id}"
  );
  let row = row.expect("copilot db row must exist");
  assert_eq!(
    row.get::<Uuid, _>("session_id"),
    session_id,
    "INV-CP-03: copilot_messages.session_id must match the session the message was appended to"
  );
  assert_eq!(
    row.get::<String, _>("role"),
    "user",
    "INV-CP-03: createCopilotMessage must store role = 'user' for user-submitted messages"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// Generated exports have private message authority, immutable publication and
/// fork-independent lifetime; input-image checks cannot protect this contract.
#[tokio::test]
async fn inv_cp_generated_files_publish_once_and_follow_current_chat_authority() {
  use axum::{
    body::Body,
    http::{Request, StatusCode},
  };
  use http_body_util::BodyExt;
  use myoxus_application::{
    auth::AuthResult,
    copilot::{ForkCopilotSession, files::*},
  };
  use myoxus_domain::entities::{CopilotFileFormat, CopilotMessageRole, CopilotSession};
  use std::sync::Arc;
  use tower::ServiceExt;
  struct Render;
  #[async_trait::async_trait]
  impl CopilotFileRenderer for Render {
    async fn authorize(&self, _: &CopilotSession) -> AuthResult<()> {
      Ok(())
    }
    async fn capture(
      &self,
      _: &CopilotAnswerSnapshot,
      _: Uuid,
      _: CopilotFileFormat,
    ) -> AuthResult<CopilotFileRenderContext> {
      Ok(CopilotFileRenderContext::Html {
        css: String::new(),
        fingerprint: "captured-fonts-and-catalog".into(),
      })
    }
    async fn render(&self, _: &CopilotAnswerSnapshot, _: CopilotFileRenderContext) -> AuthResult<Vec<u8>> {
      Ok(b"<html><body>Immutable answer</body></html>".to_vec())
    }
  }
  let (app, pool, auth_store, state) =
    helpers::setup_app_with_config_override_and_state(|config| config.copilot.enabled = true).await;
  let (user, cookie) = helpers::seed_user(&pool, &auth_store, "generated-output").await;
  let (foreign, foreign_cookie) = helpers::seed_user(&pool, &auth_store, "generated-output-foreign").await;
  let workspace = helpers::create_workspace(&pool, user).await;
  helpers::create_workspace_root_doc(&pool, workspace, user).await;
  let session = state
    .copilot()
    .create_session(user, Some(workspace), None, None, None, json!({}))
    .await
    .unwrap();
  let source = state
    .copilot()
    .append_message(
      session.id,
      CopilotMessageRole::Assistant,
      json!("# Immutable answer\n\nGrüße"),
      Some(json!({"streamStatus":"done"})),
      vec![],
      vec![],
    )
    .await
    .unwrap();
  let service = CopilotFileService {
    copilot: state.copilot().as_ref().clone(),
    storage: state.storage().clone(),
    renderer: Arc::new(Render),
    max_bytes: 1024 * 1024,
  };
  let (a, b) = tokio::join!(
    service.export(source.id, CopilotFileFormat::Html, "de".into()),
    service.export(source.id, CopilotFileFormat::Html, "de".into())
  );
  let a = a.unwrap();
  let b = b.unwrap();
  assert_eq!(a.id, b.id);
  let saved = state.copilot().get_message(source.id).await.unwrap();
  assert_eq!(saved.attachment_refs.len(), 1);
  assert_eq!(completed_answer(&saved, 1024).unwrap(), "# Immutable answer\n\nGrüße");
  // A stale source or changed authority cannot publish even a structurally valid file.
  use myoxus_domain::repositories::CopilotRepository;
  let repository = myoxus_infrastructure::copilot::SqlxCopilotRepository::new(pool.clone());
  let mut stale = saved.clone();
  stale.content = json!({"text":"outdated answer"});
  assert!(
    repository
      .commit_copilot_generated_file(&session, &stale, &a)
      .await
      .is_err()
  );
  let mut revoked = session.clone();
  revoked.metadata = json!({"authority":"changed"});
  assert!(
    repository
      .commit_copilot_generated_file(&revoked, &saved, &a)
      .await
      .is_err()
  );
  let url = format!("/api/copilot/messages/{}/files/{}", source.id, a.id);
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&url)
        .header("cookie", format!("affine_session={cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), StatusCode::OK);
  assert!(
    response.headers()["content-disposition"]
      .to_str()
      .unwrap()
      .starts_with("attachment;")
  );
  assert_eq!(response.headers()["cache-control"], "private, no-store");
  assert_eq!(
    &response.into_body().collect().await.unwrap().to_bytes()[..],
    b"<html><body>Immutable answer</body></html>"
  );
  for credential in [None, Some(foreign_cookie)] {
    let mut request = Request::builder().uri(&url);
    if let Some(cookie) = credential {
      request = request.header("cookie", format!("affine_session={cookie}"));
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(
      response.status(),
      if credential.is_none() {
        StatusCode::UNAUTHORIZED
      } else {
        StatusCode::FORBIDDEN
      }
    );
  }
  let history=helpers::gql(&app,cookie,json!({"query":"query($workspace:String!,$session:String!){currentUser{copilot(workspaceId:$workspace){chats(pagination:{first:1},options:{sessionId:$session}){edges{node{messages{id attachments generatedFiles{id downloadUrl}}}}}}}}","variables":{"workspace":workspace,"session":session.id}})).await;
  assert!(history.get("errors").is_none(), "{history}");
  let projection = &history["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"][0];
  assert_eq!(projection["generatedFiles"][0]["id"], a.id.to_string());
  assert_eq!(projection["attachments"], json!([]));
  let fork = state
    .copilot()
    .fork_session(ForkCopilotSession {
      user_id: user,
      workspace_id: workspace,
      source_session_id: session.id,
      doc_id: workspace,
      latest_message_id: None,
      can_read_attachments: true,
    })
    .await
    .unwrap();
  let copied = state.copilot().list_messages(fork.id, 10, 0).await.unwrap().remove(0);
  assert_ne!(copied.attachment_refs[0].id, a.id);
  assert_eq!(copied.attachment_refs[0].blob_key, a.blob_key);
  state.copilot().delete_session(session.id).await.unwrap();
  let copied_url = format!(
    "/api/copilot/messages/{}/files/{}",
    copied.id, copied.attachment_refs[0].id
  );
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&copied_url)
        .header("cookie", format!("affine_session={cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), StatusCode::OK);
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri(&url)
        .header("cookie", format!("affine_session={cookie}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(response.status(), StatusCode::NOT_FOUND);
  state.storage().delete_blob(&a.blob_key).await.unwrap();
  tokio::fs::remove_dir_all(format!("./test-storage/copilot-output/{workspace}"))
    .await
    .unwrap();
  helpers::cleanup_users(&pool, &[user, foreign]).await;
}
