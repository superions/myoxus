//! CORS integration tests.
//!
//! Verifies that the CORS layer responds with correct headers for:
//! - Electron Desktop (`Origin: file://`)
//! - Socket.IO polling endpoint
//! - Auth endpoints with credentials
//! - Requests without Origin header

use crate::helpers;

use axum::{body::Body, http::Request};
use tower::ServiceExt;

/// OPTIONS /graphql with Origin: file:// returns CORS headers.
#[tokio::test]
async fn cors_preflight_file_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "file://")
        .header("access-control-request-method", "POST")
        .header(
          "access-control-request-headers",
          "content-type,x-myoxus-client,x-myoxus-client-format,x-myoxus-client-capabilities",
        )
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(resp.status().as_u16(), 200);
  let h = resp.headers();
  assert_eq!(
    h.get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "file://"
  );
  assert_eq!(
    h.get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
  assert!(h.get("access-control-max-age").is_some());
  // Verify allowed headers include custom ones
  let allowed = h
    .get("access-control-allow-headers")
    .expect("expected access-control-allow-headers header")
    .to_str()
    .expect("expected JSON string")
    .to_lowercase();
  assert!(
    allowed.contains("x-myoxus-version"),
    "missing x-myoxus-version in {allowed}"
  );
  assert!(
    allowed.contains("x-myoxus-csrf-token"),
    "missing x-myoxus-csrf-token in {allowed}"
  );
  assert!(
    allowed.contains("x-myoxus-client"),
    "missing x-myoxus-client in {allowed}"
  );
  assert!(
    allowed.contains("x-myoxus-client-format"),
    "missing x-myoxus-client-format in {allowed}"
  );
  assert!(
    allowed.contains("x-myoxus-client-capabilities"),
    "missing x-myoxus-client-capabilities in {allowed}"
  );
  assert!(allowed.contains("x-request-id"), "missing x-request-id in {allowed}");
  assert!(allowed.contains("cookie"), "missing cookie in {allowed}");
}

/// POST /graphql with Origin: file:// returns CORS headers on the response.
#[tokio::test]
async fn cors_simple_request_file_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("origin", "file://")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query":"{ __typename }"}"#))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  let h = resp.headers();
  assert_eq!(
    h.get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "file://"
  );
  assert_eq!(
    h.get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
  // Expose set-cookie
  let exposed = h
    .get("access-control-expose-headers")
    .expect("expected access-control-expose-headers header")
    .to_str()
    .expect("expected JSON string")
    .to_lowercase();
  assert!(
    exposed.contains("set-cookie"),
    "missing set-cookie in exposed headers: {exposed}"
  );
}

/// OPTIONS /graphql without Origin returns 200 but no CORS headers.
#[tokio::test]
async fn cors_no_origin_header() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  // Without Origin, CORS layer should not add allow-origin header.
  assert!(resp.headers().get("access-control-allow-origin").is_none());
}

/// OPTIONS /socket.io/?EIO=4&transport=polling with Origin returns CORS headers.
#[tokio::test]
async fn cors_socketio_polling_preflight() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  // Socket.IO polling handshake (GET) with a cross-origin header.
  // The CORS layer must add allow-origin even on the Engine.IO response.
  let resp = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .header("origin", "file://")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(resp.status().as_u16(), 200, "socket.io handshake must succeed");
  let h = resp.headers();
  assert_eq!(
    h.get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "file://",
    "CORS origin header must be present on socket.io responses"
  );
  assert_eq!(
    h.get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true",
    "CORS credentials header must be present"
  );
}

/// POST /api/auth/sign-in with Origin returns CORS headers with credentials.
#[tokio::test]
async fn cors_auth_endpoint_with_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/auth/sign-in")
        .header("origin", "file://")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"email":"test@example.com","password":"test"}"#))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  let h = resp.headers();
  assert_eq!(
    h.get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "file://"
  );
  assert_eq!(
    h.get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}

/// An unknown origin is rejected (no CORS headers).
#[tokio::test]
async fn cors_unknown_origin_rejected() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "https://evil.example.com")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  // With a predicate-based allow_origin, tower-http still returns 200 for
  // OPTIONS but omits the access-control-allow-origin header when the
  // predicate returns false.
  assert!(resp.headers().get("access-control-allow-origin").is_none());
}

/// OPTIONS /graphql with Origin: app://myoxus returns CORS headers (Electron custom protocol).
#[tokio::test]
async fn cors_preflight_app_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "app://myoxus")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "app://myoxus"
  );
  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}

/// OPTIONS /graphql with Origin: myoxus-app://main returns CORS headers.
#[tokio::test]
async fn cors_preflight_affine_app_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "myoxus-app://main")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "myoxus-app://main"
  );
  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}

/// OPTIONS /graphql with Origin: tauri://localhost returns CORS headers.
#[tokio::test]
async fn cors_preflight_tauri_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "tauri://localhost")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "tauri://localhost"
  );
  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}

/// OPTIONS /graphql with Origin: myoxus://app returns CORS headers.
#[tokio::test]
async fn cors_preflight_myoxus_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "myoxus://app")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "myoxus://app"
  );
  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}

/// Origin: null (sandboxed iframe / Electron dev) returns CORS headers.
#[tokio::test]
async fn cors_preflight_null_origin() {
  let (app, _pool, _auth) = helpers::setup_app().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("OPTIONS")
        .uri("/graphql")
        .header("origin", "null")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-origin")
      .expect("expected access-control-allow-origin header"),
    "null"
  );
  assert_eq!(
    resp
      .headers()
      .get("access-control-allow-credentials")
      .expect("expected access-control-allow-credentials header"),
    "true"
  );
}
