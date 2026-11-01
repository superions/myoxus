// SPDX-License-Identifier: AGPL-3.0-or-later
//! P100-SRV-F-12 — Integration test: WebSocket push on notification.
//!
//! Invariant (INV-F-12): When a notification is created for a user who has an
//! open WebSocket connection subscribed to notifications, the server pushes a
//! `notification:push` event to that socket within a short time window.
//!
//! The test uses the Engine.IO polling transport (same approach as socketio_auth_test.rs)
//! to verify the end-to-end push flow without a native WebSocket client.

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Engine.IO / Socket.IO protocol helpers (copied from socketio_auth_test.rs)
// ---------------------------------------------------------------------------

/// Perform the Engine.IO handshake (optionally with cookie) and return the sid.
async fn eio_handshake(app: &axum::Router, cookie: Option<&str>) -> String {
  let mut builder = Request::builder()
    .method("GET")
    .uri("/socket.io/?EIO=4&transport=polling");
  if let Some(c) = cookie {
    builder = builder.header("cookie", c);
  }
  let resp = app
    .clone()
    .oneshot(builder.body(Body::empty()).expect("build request"))
    .await
    .expect("handshake");
  assert_eq!(resp.status().as_u16(), 200, "Engine.IO handshake must succeed");
  let body = resp.into_body().collect().await.expect("collect body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let json_start = text.find('{').expect("no JSON in EIO open");
  let json_end = text.rfind('}').expect("no closing brace") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[json_start..json_end]).expect("invalid EIO JSON");
  json["sid"].as_str().expect("missing sid").to_string()
}

/// POST a Socket.IO packet to the server (client → server event).
async fn sio_post(app: &axum::Router, sid: &str, cookie: Option<&str>, body: &str) {
  let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
  let mut builder = Request::builder()
    .method("POST")
    .uri(&uri)
    .header("content-type", "text/plain;charset=UTF-8");
  if let Some(c) = cookie {
    builder = builder.header("cookie", c);
  }
  let _resp = app
    .clone()
    .oneshot(builder.body(Body::from(body.to_string())).expect("build request"))
    .await
    .expect("sio_post");
}

/// GET pending server packets. Handles EIO ping/pong. Returns the body string.
async fn sio_poll(app: &axum::Router, sid: &str, cookie: Option<&str>) -> String {
  const MAX_POLLS: usize = 15;
  for _ in 0..MAX_POLLS {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let mut builder = Request::builder().method("GET").uri(&uri);
    if let Some(c) = cookie {
      builder = builder.header("cookie", c);
    }
    let resp = app
      .clone()
      .oneshot(builder.body(Body::empty()).expect("build request"))
      .await
      .expect("sio_poll");
    let body = resp.into_body().collect().await.expect("collect body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();

    if text.contains("40{") || text.contains("44") || text.contains("42[") || text.contains("4{") {
      return text;
    }
    // Engine.IO ping → respond with pong
    if text.trim() == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3").await;
      continue;
    }
    // noop or empty
    if text.trim().is_empty() || text == "6" || text.contains(":6") {
      continue;
    }
  }
  String::new()
}

/// Poll repeatedly for a packet containing `needle`, up to `max_attempts` polls
/// with a small sleep between each. Returns the first matching response.
async fn sio_wait_for(
  app: &axum::Router,
  sid: &str,
  cookie: Option<&str>,
  needle: &str,
  max_attempts: usize,
) -> Option<String> {
  for _ in 0..max_attempts {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let mut builder = Request::builder().method("GET").uri(&uri);
    if let Some(c) = cookie {
      builder = builder.header("cookie", c);
    }
    let resp = app
      .clone()
      .oneshot(builder.body(Body::empty()).expect("build request"))
      .await
      .expect("sio_wait_for");
    let body = resp.into_body().collect().await.expect("collect body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();

    if text.contains(needle) {
      return Some(text);
    }
    // Handle EIO ping
    if text.trim() == "2" || text.contains(":2") {
      sio_post(app, sid, cookie, "3").await;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
  }
  None
}

// ---------------------------------------------------------------------------
// P100-SRV-F-12: inv_f_notification_websocket_push
// ---------------------------------------------------------------------------

/// INV-F-12: WebSocket push delivers notification:push event to subscribed socket.
///
/// Flow:
/// 1. User connects via EIO polling transport.
/// 2. User sends `notification:subscribe` event.
/// 3. `publish_user_notification` is called with `notification_new` event.
/// 4. The socket receives a `notification:push` packet within 5 seconds.
///
/// The event payload must contain `notificationType` and `notificationId`.
#[tokio::test]
async fn inv_f_notification_websocket_push() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth, "notif_ws_push").await;
  let cookie = format!("affine_session={session_id}");

  // Step 1: EIO handshake with session cookie
  let sid = eio_handshake(&app, Some(&cookie)).await;
  assert!(!sid.is_empty(), "EIO sid must not be empty");

  // Step 2: Socket.IO namespace connect (packet `40` with cookie auth)
  sio_post(&app, &sid, Some(&cookie), "40").await;

  // Wait for namespace connect ACK (40{...})
  let ack = sio_poll(&app, &sid, Some(&cookie)).await;
  assert!(
    ack.contains("40{") || ack.contains("40\""),
    "expected namespace connect ACK, got: {ack}"
  );
  assert!(
    !ack.contains("AUTHENTICATION_REQUIRED"),
    "authenticated connect must not fail"
  );

  // Step 3: Emit notification:subscribe from client
  // Socket.IO message: packet type 4 (message) + type 2 (event) = "42"
  // Payload: ["notification:subscribe"]
  sio_post(&app, &sid, Some(&cookie), r#"42["notification:subscribe"]"#).await;

  // Wait briefly for the server to process the subscribe event
  tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

  // Step 4: Push a notification via the internal broadcast channel
  let notification_id = Uuid::new_v4().to_string();
  myoxus_api::websocket::publish_user_notification(
    None,
    user_id,
    "notification_new",
    json!({
      "notificationId": notification_id,
      "notificationType": "workspace_invitation",
      "payload": { "workspaceId": Uuid::new_v4().to_string() }
    }),
  )
  .await;

  // Step 5: Poll until we receive the notification:push event (up to ~5s)
  let push_response = sio_wait_for(&app, &sid, Some(&cookie), "notification:push", 33).await;

  assert!(
    push_response.is_some(),
    "INV-F-12: expected notification:push event within 5s, but none received. \
     Invariant: publish_user_notification → subscribed socket receives notification:push packet."
  );

  let resp_text = push_response.unwrap();
  assert!(
    resp_text.contains("notificationType") || resp_text.contains("notification_new"),
    "INV-F-12: notification:push payload must contain notificationType, got: {resp_text}"
  );
  assert!(
    resp_text.contains(&notification_id) || resp_text.contains("notificationId"),
    "INV-F-12: notification:push payload must contain notificationId, got: {resp_text}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// T02-F-02 — inv_expired_invite_link_is_rejected
//
// Invariant: an invite link whose expires_at is in the past must be rejected
// when a user attempts to redeem it. The user must NOT be added to the workspace.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_expired_invite_link_is_rejected() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "inv_exp_owner").await;
  let (joiner_id, joiner_session) = helpers::seed_user(&pool, &auth_store, "inv_exp_joiner").await;

  // Step 1: Owner creates workspace and generates an invite link.
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let resp = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": r#"mutation IL($wid: ID!) {
        createInviteLink(workspaceId: $wid, expireTime: OneDay) { link }
      }"#,
      "variables": { "wid": ws_id.to_string() }
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_none(),
    "T02-F-02: createInviteLink must succeed: {resp}"
  );
  let invite_url = resp["data"]["createInviteLink"]["link"]
    .as_str()
    .expect("T02-F-02: createInviteLink must return an invite URL")
    .to_string();
  assert!(
    invite_url.starts_with("http://") || invite_url.starts_with("https://"),
    "T02-F-02: invite link must be an absolute URL, got {invite_url}"
  );
  let raw_token = invite_url
    .rsplit_once("/invite/")
    .map(|(_, token)| token.to_string())
    .expect("T02-F-02: invite URL must route to /invite/{token}");

  // Step 2: Manually expire the invite link in the DB.
  sqlx::query("UPDATE workspace_invite_links SET expires_at = NOW() - INTERVAL '1 hour' WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("T02-F-02: must be able to expire invite link directly in DB");

  // Step 3: Joiner attempts to accept the expired invite link.
  let accept_resp = helpers::gql(
    &app,
    joiner_session,
    json!({
      "query": r#"mutation AW($wid: String!, $inv: String!) {
        acceptWorkspaceInvite(workspaceId: $wid, inviteId: $inv)
      }"#,
      "variables": { "wid": ws_id.to_string(), "inv": raw_token }
    }),
  )
  .await;

  // Step 4: Response must indicate rejection (GraphQL error).
  assert!(
    accept_resp.get("errors").is_some(),
    "T02-F-02: expired invite link must be rejected with an error, got: {accept_resp}"
  );

  // Step 5: DB invariant — joiner must NOT be in workspace_memberships.
  let membership: Option<String> =
    sqlx::query_scalar("SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(ws_id)
      .bind(joiner_id)
      .fetch_optional(&pool)
      .await
      .expect("T02-F-02: membership query must not fail");
  assert!(
    membership.is_none(),
    "T02-F-02: joiner must NOT have a membership row after expired-link rejection, got: {membership:?}"
  );

  helpers::cleanup_users(&pool, &[owner_id, joiner_id]).await;
}
