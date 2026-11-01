//! Compatibility tests verifying legacy REST endpoint shapes match the original AFFiNE API.
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use serde_json::{Value, json};
use tower::ServiceExt;

fn test_state() -> ApiState {
  let config = AppConfig::load().expect("config");
  ApiState::new(config).with_html_catalog(std::sync::Arc::new(
    myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
    ),
  ))
}

fn test_state_with<F>(mutate: F) -> ApiState
where
  F: FnOnce(&mut AppConfig),
{
  let mut config = AppConfig::load().expect("config");
  mutate(&mut config);
  ApiState::new(config).with_html_catalog(std::sync::Arc::new(
    myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
    ),
  ))
}

#[tokio::test]
async fn telemetry_collect_acknowledges_batch() {
  let app = build_router(test_state());
  let payload = json!({
    "events": [
      {"schemaVersion": 1, "eventName": "pageView", "clientId": "c1", "eventId": "id1"},
      {"schemaVersion": 1, "eventName": "doc.create", "clientId": "c1", "eventId": "id2"}
    ]
  });

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/telemetry/collect")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["ok"], true);
  assert_eq!(json["accepted"], 2);
  assert_eq!(json["dropped"], 0);
}

/// Unauthenticated calls to the link-preview proxy must be rejected with 401
/// (SEC-03: auth gate prevents open-proxy / SSRF abuse).
#[tokio::test]
async fn worker_link_preview_requires_authentication() {
  let app = build_router(test_state());
  let payload = json!({ "url": "file:///etc/passwd", "head": false });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/worker/link-preview")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 401);
}

/// Unauthenticated calls to the image-proxy must be rejected with 401
/// (SEC-03: auth gate prevents open-proxy / SSRF abuse).
#[tokio::test]
async fn worker_image_proxy_requires_authentication() {
  let app = build_router(test_state());
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/worker/image-proxy?url=file:///etc/passwd")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn worker_questionnaire_get_returns_array_contract() {
  let app = build_router(test_state());
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/worker/questionnaire")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(json.is_array());
}

#[tokio::test]
async fn worker_questionnaire_post_accepts_payload_contract() {
  let app = build_router(test_state());
  let payload = json!({
    "form": "user-id",
    "ask": "question-id",
    "answer": ["a", "b"]
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/worker/questionnaire")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 204);
}

#[tokio::test]
async fn mcp_get_and_delete_return_method_not_allowed_contract() {
  let app = build_router(test_state());
  let ws = uuid::Uuid::new_v4();
  for method in ["GET", "DELETE"] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method(method)
          .uri(format!("/api/workspaces/{ws}/mcp/"))
          .body(Body::empty())
          .expect("HTTP request failed"),
      )
      .await
      .expect("HTTP request failed");
    assert_eq!(response.status(), 405);
    let body = response.into_body().collect().await.expect("collect body").to_bytes();
    let json: Value = serde_json::from_slice(&body).expect("JSON parse");
    assert_eq!(json["jsonrpc"], "2.0");
    assert_eq!(json["error"]["code"], -32000);
  }
}

#[tokio::test]
async fn rpc_endpoints_require_authenticated_session() {
  let app = build_router(test_state());
  let ws = uuid::Uuid::new_v4();
  let doc = uuid::Uuid::new_v4();
  let endpoints = vec![
    format!("/rpc/workspaces/{ws}/docs/{doc}"),
    format!("/rpc/workspaces/{ws}/docs/{doc}/content"),
    format!("/rpc/workspaces/{ws}/docs/{doc}/markdown"),
    format!("/rpc/workspaces/{ws}/content"),
  ];

  for uri in endpoints {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(uri)
          .body(Body::empty())
          .expect("HTTP request failed"),
      )
      .await
      .expect("HTTP request failed");
    assert_eq!(response.status(), 401);
  }
}

#[tokio::test]
async fn workspace_docs_endpoints_require_authenticated_session() {
  let app = build_router(test_state());
  let ws = uuid::Uuid::new_v4();
  let doc = uuid::Uuid::new_v4();
  let endpoints = vec![
    format!("/api/workspaces/{ws}/docs/{doc}"),
    format!("/api/workspaces/{ws}/docs/{doc}/histories/1700000000000"),
    format!("/api/workspaces/{ws}/docs/{doc}/comment-attachments/key.bin"),
  ];
  for uri in endpoints {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(uri)
          .body(Body::empty())
          .expect("HTTP request failed"),
      )
      .await
      .expect("HTTP request failed");
    assert_eq!(response.status(), 401);
  }
}

#[tokio::test]
async fn storage_proxy_routes_reject_invalid_or_missing_signature() {
  let app = build_router(test_state());
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri("/api/storage/upload")
        .body(Body::from("abc"))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 400);

  let response = app
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri("/api/storage/multipart")
        .body(Body::from("abc"))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn workspace_renderer_routes_return_html_shell() {
  let app = build_router(test_state());
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/workspace")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let html = String::from_utf8_lossy(&body);
  assert!(html.contains("<!doctype html>"));

  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/workspace/not-a-uuid")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn copilot_unsplash_photos_returns_empty_payload_when_not_configured() {
  let app = build_router(test_state());
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/copilot/unsplash/photos?query=nature")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["total"], 0);
  assert_eq!(json["total_pages"], 0);
  assert_eq!(json["results"], json!([]));
}

#[tokio::test]
async fn copilot_chat_stream_route_returns_sse_error_event_contract() {
  let app = build_router(test_state());
  let session_id = uuid::Uuid::new_v4();
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/copilot/chat/{session_id}/stream-object?messageId=test"))
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let content_type = response
    .headers()
    .get("content-type")
    .and_then(|h| h.to_str().ok())
    .unwrap_or("");
  assert!(content_type.contains("text/event-stream"));
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  assert!(text.contains("event: error"));
  assert!(
    text.contains("\"code\":\"UNAUTHORIZED\"") || text.contains("\"status\":401"),
    "expected UNAUTHORIZED code or status:401 in SSE error, got: {text}"
  );
}

#[tokio::test]
async fn copilot_chat_stream_route_rejects_unknown_endpoint() {
  let app = build_router(test_state());
  let session_id = uuid::Uuid::new_v4();
  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/copilot/chat/{session_id}/unknown"))
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn calendar_google_webhook_enforces_configured_token_when_enabled() {
  let app = build_router(test_state_with(|cfg| {
    cfg.calendar.google_webhook.enabled = true;
    cfg.calendar.google_webhook.token = Some("secret-token".to_string());
  }));

  let unauthorized = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", "ch-1")
        .header("x-goog-channel-token", "wrong-token")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(unauthorized.status(), 401);

  let ok = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", "ch-1")
        .header("x-goog-channel-token", "secret-token")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(ok.status(), 200);
}
