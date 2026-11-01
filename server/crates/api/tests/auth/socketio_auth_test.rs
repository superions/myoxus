//! Integration tests for the Socket.IO auth middleware (P32-A/B/E).
//!
//! Tests the Engine.IO/Socket.IO polling protocol at the HTTP level to verify:
//! - Cookie-based authentication (web client mode)
//! - `auth.token` handshake authentication (desktop/mobile client mode)
//! - Token-takes-priority when both cookie and auth.token are present
//! - Rejection when no auth credentials are provided
//!
//! Protocol reference (Engine.IO v4 + Socket.IO v4):
//!   1. GET  /socket.io/?EIO=4&transport=polling           -> Engine.IO open packet (sid)
//!   2. POST /socket.io/?EIO=4&transport=polling&sid=...   -> Socket.IO namespace connect
//!   3. GET  /socket.io/?EIO=4&transport=polling&sid=...   -> read server packets

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_application::client_update::ClientUpdateCommand;
use myoxus_contracts::client_update::CLIENT_UPDATE_CONFIG_KEY;
use myoxus_infrastructure::client_update::PgClientUpdateRepository;
use tower::ServiceExt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Engine.IO / Socket.IO protocol helpers
// ---------------------------------------------------------------------------

/// Perform the Engine.IO handshake and return the transport `sid`.
async fn eio_handshake(app: &axum::Router) -> String {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(resp.status().as_u16(), 200, "Engine.IO handshake must succeed");
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  // Engine.IO open packet: `0{"sid":"...","upgrades":[...],...}`
  // The body may have a length-prefix for polling: e.g. `0{"sid":"xxx",...}`
  let json_start = text.find('{').expect("no JSON in EIO open packet");
  let json_end = text.rfind('}').expect("no closing brace") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[json_start..json_end]).expect("invalid EIO JSON");
  json["sid"].as_str().expect("missing sid in EIO open").to_string()
}

/// Send a Socket.IO namespace connect request via POST polling.
/// Returns the response body as a string.
async fn sio_connect(app: &axum::Router, sid: &str, cookie: Option<&str>, sio_body: &str) -> String {
  let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
  let mut builder = Request::builder()
    .method("POST")
    .uri(&uri)
    .header("content-type", "text/plain;charset=UTF-8");
  if let Some(c) = cookie {
    builder = builder.header("cookie", c);
  }
  let resp = app
    .clone()
    .oneshot(
      builder
        .body(Body::from(sio_body.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  String::from_utf8_lossy(&body).to_string()
}

/// Read pending server packets via GET polling. Returns the body string.
///
/// Handles the Engine.IO ping/pong cycle: if the server sends a `2` (ping),
/// we respond with `3` (pong) via POST and poll again. This repeats up to
/// `MAX_POLLS` times until we get an actual Socket.IO packet (starting with
/// `4` — i.e. `40`, `44`, etc.) or exhaust retries.
async fn sio_poll(app: &axum::Router, sid: &str, cookie: Option<&str>) -> String {
  const MAX_POLLS: usize = 10;
  for _ in 0..MAX_POLLS {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let mut builder = Request::builder().method("GET").uri(&uri);
    if let Some(c) = cookie {
      builder = builder.header("cookie", c);
    }
    let resp = app
      .clone()
      .oneshot(builder.body(Body::empty()).expect("HTTP request failed"))
      .await
      .expect("HTTP request failed");
    let body = resp.into_body().collect().await.expect("collect body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();

    // Check if response contains a Socket.IO-level packet (type 4x).
    // These may be length-prefixed: "NN:4..." or bare "4...".
    if text.contains("40") || text.contains("44") || text.contains("4{") {
      return text;
    }

    // Engine.IO ping (`2`) — respond with pong (`3`) and poll again.
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      let post_uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
      let mut post_builder = Request::builder()
        .method("POST")
        .uri(&post_uri)
        .header("content-type", "text/plain;charset=UTF-8");
      if let Some(c) = cookie {
        post_builder = post_builder.header("cookie", c);
      }
      let _pong_resp = app
        .clone()
        .oneshot(post_builder.body(Body::from("3")).expect("HTTP request failed"))
        .await
        .expect("HTTP request failed");
      continue;
    }

    // Engine.IO noop (`6`) or other non-SIO packets — just poll again.
    if text == "6" || text.contains(":6") || text.starts_with("1:6") {
      continue;
    }

    // Unknown packet — return it so the test assertion can report it.
    return text;
  }
  panic!("sio_poll: exhausted {MAX_POLLS} polls without receiving a Socket.IO packet");
}

/// Perform EIO handshake with a cookie header set (so the SIO connect
/// request inherits the same transport session).
async fn eio_handshake_with_cookie(app: &axum::Router, cookie: &str) -> String {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .header("cookie", cookie)
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(resp.status().as_u16(), 200);
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let json_start = text.find('{').expect("no JSON in EIO open");
  let json_end = text.rfind('}').expect("no closing brace") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[json_start..json_end]).expect("invalid EIO JSON");
  json["sid"].as_str().expect("missing sid").to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// P32-A-04: Engine.IO handshake always succeeds (transport-level, no auth).
#[tokio::test]
async fn inv_p32a04_eio_handshake_succeeds_without_auth() {
  let (app, pool, _auth) = helpers::setup_app().await;
  let sid = eio_handshake(&app).await;
  assert!(!sid.is_empty(), "Engine.IO must return a non-empty sid");
  // No users created, nothing to clean up.
  let _ = pool;
}

/// P32-A-04: SIO namespace connect WITHOUT any auth credentials returns
/// a connect_error packet with AUTHENTICATION_REQUIRED.
#[tokio::test]
async fn inv_p32a04_sio_connect_without_auth_returns_connect_error() {
  let (app, pool, _auth) = helpers::setup_app().await;
  let sid = eio_handshake(&app).await;

  // Send namespace connect `40` (no auth payload, no cookie)
  let _post_resp = sio_connect(&app, &sid, None, "40").await;

  // Poll for the server's response — should contain a connect_error packet.
  // Socket.IO connect_error is packet type `44`: `44{"message":"..."}`
  let poll_resp = sio_poll(&app, &sid, None).await;
  assert!(
    poll_resp.contains("AUTHENTICATION_REQUIRED") || poll_resp.contains("connect_error") || poll_resp.contains("44"),
    "expected connect_error with AUTHENTICATION_REQUIRED, got: {poll_resp}"
  );

  let _ = pool;
}

/// P32-A-04: SIO namespace connect WITH valid session cookie succeeds.
/// The server responds with a namespace connect ACK (`40{"sid":"..."}`).
#[tokio::test]
async fn inv_p32a04_sio_connect_with_valid_cookie_succeeds() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_cookie").await;

  let cookie = format!("affine_session={session_id}");
  let sid = eio_handshake_with_cookie(&app, &cookie).await;

  // Send `40` (bare namespace connect — auth comes from cookie)
  let _post_resp = sio_connect(&app, &sid, Some(&cookie), "40").await;

  // Poll for server response — should contain `40{` (namespace connected)
  let poll_resp = sio_poll(&app, &sid, Some(&cookie)).await;
  assert!(
    poll_resp.contains("40{") || poll_resp.contains("40\""),
    "expected namespace connect ACK (40{{...}}), got: {poll_resp}"
  );
  // Must NOT contain connect_error
  assert!(
    !poll_resp.contains("AUTHENTICATION_REQUIRED"),
    "authenticated connection must not get AUTHENTICATION_REQUIRED"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_sync_web_handshake_uses_cookie_session_and_ignores_legacy_profile_id() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_web_identity").await;
  let cookie = format!("affine_session={session_id}");

  for compatible_body in [
    r#"40{}"#.to_string(),
    r#"40{"clientKind":"web","clientInstanceId":"not-a-uuid"}"#.to_string(),
    format!(r#"40{{"clientKind":"web","clientInstanceId":"{}"}}"#, Uuid::new_v4()),
  ] {
    let sid = eio_handshake_with_cookie(&app, &cookie).await;
    sio_connect(&app, &sid, Some(&cookie), &compatible_body).await;
    let response = sio_poll(&app, &sid, Some(&cookie)).await;
    assert!(
      response.contains("40{") || response.contains("40\""),
      "cookie-authenticated Browser Web must connect without a profile identity: {response}"
    );
  }

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn suspended_update_policy_rejects_only_new_browser_web_sockets() {
  let _guard = helpers::CLIENT_UPDATE_CONTROL_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let (app, pool, auth) = helpers::setup_app().await;
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(CLIENT_UPDATE_CONFIG_KEY)
    .execute(&pool)
    .await
    .expect("policy cleanup");
  let repository = PgClientUpdateRepository::new(pool.clone());
  let operation_id = Uuid::new_v4();
  repository
    .apply(ClientUpdateCommand::LimitRetry {
      operation_id,
      max_attempts: 1,
      retry_after_ms: 1_000,
    })
    .await
    .expect("limited policy");
  repository
    .apply(ClientUpdateCommand::NoRetry { operation_id })
    .await
    .expect("suspended policy");
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_update_policy").await;
  let cookie = format!("affine_session={session_id}");

  let web_sid = eio_handshake_with_cookie(&app, &cookie).await;
  sio_connect(&app, &web_sid, Some(&cookie), r#"40{"clientKind":"electron"}"#).await;
  let web_response = sio_poll(&app, &web_sid, Some(&cookie)).await;
  assert!(
    web_response.contains("44") && web_response.contains("client_update_maintenance"),
    "suspended Browser Web handshake must fail with the stable maintenance contract: {web_response}"
  );

  let native_sid = eio_handshake(&app).await;
  let native_body = format!(r#"40{{"token":"{session_id}","clientKind":"electron"}}"#);
  sio_connect(&app, &native_sid, None, &native_body).await;
  let native_response = sio_poll(&app, &native_sid, None).await;
  assert!(
    native_response.contains("40{") || native_response.contains("40\""),
    "the Browser Web update gate must not reject native clients: {native_response}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(CLIENT_UPDATE_CONFIG_KEY)
    .execute(&pool)
    .await
    .expect("policy cleanup");
}

#[tokio::test]
async fn inv_sync_connection_admission_returns_typed_retry_contract() {
  let (app, pool, auth) = helpers::setup_app_with_config_override(|config| {
    config.websocket.max_connections_per_second_per_client = 2;
  })
  .await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_admission").await;
  let cookie = format!("affine_session={session_id}");

  for attempt in 1..=2 {
    let sid = eio_handshake_with_cookie(&app, &cookie).await;
    sio_connect(&app, &sid, Some(&cookie), "40").await;
    let response = sio_poll(&app, &sid, Some(&cookie)).await;
    assert!(
      response.contains("40{") || response.contains("40\""),
      "attempt {attempt} in the authenticated session must connect: {response}"
    );
  }

  let rejected_sid = eio_handshake_with_cookie(&app, &cookie).await;
  sio_connect(&app, &rejected_sid, Some(&cookie), "40").await;
  let rejected = sio_poll(&app, &rejected_sid, Some(&cookie)).await;
  assert!(
    rejected.contains("44"),
    "rejection must be a Socket.IO connect_error: {rejected}"
  );
  assert!(
    rejected.contains("rate_limited"),
    "rejection must expose the stable error code: {rejected}"
  );
  assert!(
    rejected.contains("retryAfterMs"),
    "rejection must expose the server retry floor: {rejected}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;

  let (unavailable_app, unavailable_pool, unavailable_auth) =
    helpers::setup_app_with_socket_admission_redis_url("redis://127.0.0.1:1").await;
  let (unavailable_user_id, unavailable_session_id) =
    helpers::seed_user(&unavailable_pool, &unavailable_auth, "sio_admission_unavailable").await;
  let unavailable_cookie = format!("affine_session={unavailable_session_id}");
  let unavailable_sid = eio_handshake_with_cookie(&unavailable_app, &unavailable_cookie).await;
  sio_connect(&unavailable_app, &unavailable_sid, Some(&unavailable_cookie), "40").await;
  let unavailable = sio_poll(&unavailable_app, &unavailable_sid, Some(&unavailable_cookie)).await;
  assert!(
    unavailable.contains("44") && unavailable.contains("temporarily_unavailable"),
    "Redis failure must fail the real namespace connection with the typed temporary error: {unavailable}"
  );

  helpers::cleanup_users(&unavailable_pool, &[unavailable_user_id]).await;
}

/// Cookie compatibility: SIO namespace connect also accepts legacy `affine_sid`.
#[tokio::test]
async fn inv_p32a04_sio_connect_with_legacy_sid_cookie_succeeds() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_legacy_cookie").await;

  let cookie = format!("affine_sid={session_id}");
  let sid = eio_handshake_with_cookie(&app, &cookie).await;
  let _post_resp = sio_connect(&app, &sid, Some(&cookie), "40").await;

  let poll_resp = sio_poll(&app, &sid, Some(&cookie)).await;
  assert!(
    poll_resp.contains("40{") || poll_resp.contains("40\""),
    "expected namespace connect ACK with legacy affine_sid cookie, got: {poll_resp}"
  );
  assert!(
    !poll_resp.contains("AUTHENTICATION_REQUIRED"),
    "legacy affine_sid cookie must not get AUTHENTICATION_REQUIRED"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P32-A-05: SIO namespace connect with `auth.token` in handshake data
/// (Desktop/Mobile client mode) succeeds.
#[tokio::test]
async fn inv_p32a05_sio_connect_with_auth_token_succeeds() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_token").await;

  // No cookie — token goes in the SIO connect packet body
  let sid = eio_handshake(&app).await;

  // Socket.IO connect with auth payload: `40{"token":"<session-uuid>","userId":"<user-uuid>"}`
  let connect_body = format!(r#"40{{"token":"{session_id}","userId":"{user_id}"}}"#);
  let _post_resp = sio_connect(&app, &sid, None, &connect_body).await;

  let poll_resp = sio_poll(&app, &sid, None).await;
  assert!(
    poll_resp.contains("40{") || poll_resp.contains("40\""),
    "expected namespace connect ACK with auth.token, got: {poll_resp}"
  );
  assert!(
    !poll_resp.contains("AUTHENTICATION_REQUIRED"),
    "auth.token mode must not get AUTHENTICATION_REQUIRED"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P32-B-02: When BOTH cookie AND auth.token are provided, auth.token
/// takes priority. We verify by using a valid token + invalid cookie.
#[tokio::test]
async fn inv_p32b02_auth_token_takes_priority_over_cookie() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "sio_priority").await;

  // Use an invalid cookie but valid auth.token
  let bogus_cookie = format!("affine_session={}", Uuid::new_v4());
  let sid = eio_handshake_with_cookie(&app, &bogus_cookie).await;

  let connect_body = format!(r#"40{{"token":"{session_id}","userId":"{user_id}"}}"#);
  let _post_resp = sio_connect(&app, &sid, Some(&bogus_cookie), &connect_body).await;

  let poll_resp = sio_poll(&app, &sid, Some(&bogus_cookie)).await;
  // Even though the cookie is invalid, the valid auth.token should succeed
  assert!(
    poll_resp.contains("40{") || poll_resp.contains("40\""),
    "auth.token should take priority over invalid cookie, got: {poll_resp}"
  );
  assert!(
    !poll_resp.contains("AUTHENTICATION_REQUIRED"),
    "valid auth.token must override invalid cookie"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// P32-A-04 (negative): An invalid/expired session cookie causes
/// connect_error, not a successful namespace join.
#[tokio::test]
async fn inv_p32a04_sio_connect_with_invalid_cookie_returns_connect_error() {
  let (app, pool, _auth) = helpers::setup_app().await;

  let bogus_cookie = format!("affine_session={}", Uuid::new_v4());
  let sid = eio_handshake_with_cookie(&app, &bogus_cookie).await;

  let _post_resp = sio_connect(&app, &sid, Some(&bogus_cookie), "40").await;

  let poll_resp = sio_poll(&app, &sid, Some(&bogus_cookie)).await;
  assert!(
    poll_resp.contains("AUTHENTICATION_REQUIRED") || poll_resp.contains("44"),
    "invalid cookie must cause connect_error, got: {poll_resp}"
  );

  let _ = pool;
}

/// P32-A-05 (negative): An invalid auth.token (non-existent session UUID)
/// causes connect_error.
#[tokio::test]
async fn inv_p32a05_sio_connect_with_invalid_auth_token_returns_connect_error() {
  let (app, pool, _auth) = helpers::setup_app().await;

  let sid = eio_handshake(&app).await;
  let bogus_session = Uuid::new_v4();
  let bogus_user = Uuid::new_v4();
  let connect_body = format!(r#"40{{"token":"{bogus_session}","userId":"{bogus_user}"}}"#);
  let _post_resp = sio_connect(&app, &sid, None, &connect_body).await;

  let poll_resp = sio_poll(&app, &sid, None).await;
  assert!(
    poll_resp.contains("AUTHENTICATION_REQUIRED") || poll_resp.contains("44"),
    "invalid auth.token must cause connect_error, got: {poll_resp}"
  );

  let _ = pool;
}

/// P32-D-04: Engine.IO handshake advertises maxPayload = 100 MB (104857600),
/// which proves that the socketioxide builder received the configured
/// max_http_buffer_size. This prevents regressions where large doc updates
/// (> 100 KB) are silently rejected by the transport layer.
#[tokio::test]
async fn inv_p32d04_eio_handshake_advertises_100mb_max_payload() {
  let (app, pool, _auth) = helpers::setup_app().await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(resp.status().as_u16(), 200);
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let text = String::from_utf8_lossy(&body);

  // Parse the Engine.IO open packet JSON
  let json_start = text.find('{').expect("no JSON in EIO open packet");
  let json_end = text.rfind('}').expect("no closing brace") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[json_start..json_end]).expect("invalid EIO JSON");

  let max_payload = json["maxPayload"]
    .as_u64()
    .expect("EIO open packet must contain maxPayload");

  // Must be 100 MB = 104857600, NOT the old socketioxide default (100 KB = 102400)
  assert_eq!(
    max_payload, 104_857_600,
    "EIO maxPayload must be 100 MB (104857600), got {max_payload}"
  );

  let _ = pool;
}

/// P32-D-04: Engine.IO POST polling accepts a payload larger than the old
/// default (100 KB). This sends a 200 KB body to a valid session and verifies
/// the transport layer does not reject it with a 413 or close the connection.
#[tokio::test]
async fn inv_p32d04_eio_accepts_payload_larger_than_old_100kb_default() {
  let (app, pool, _auth) = helpers::setup_app().await;

  let sid = eio_handshake(&app).await;

  // Build a payload > 100 KB (the old default).
  // We use a dummy SIO message. The content doesn't matter for this test —
  // we only verify that the transport layer accepts the body size.
  // 200 KB of 'A's, prefixed with SIO message type `42` (event).
  let large_data = "A".repeat(200 * 1024);
  let payload = format!(r#"42["dummy","{large_data}"]"#);

  let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri(&uri)
        .header("content-type", "text/plain;charset=UTF-8")
        .body(Body::from(payload))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  // The server must NOT reject the payload with 413 (Payload Too Large) or
  // 400 (Bad Request due to size). Engine.IO POST typically returns 200 "ok".
  let status = resp.status().as_u16();
  assert!(
    status == 200 || status == 204,
    "200 KB payload must be accepted by transport (got HTTP {status}); \
     old 100 KB default would reject this"
  );

  let _ = pool;
}
