// SPDX-License-Identifier: AGPL-3.0-or-later
//! P83-C-01: WebSocket Doc-Load → View-Tracking E2E test.
//!
//! Invariant (INV-WS-VIEW-01):
//!   After a Socket.IO client authenticates and sends `space:load-doc` for a
//!   workspace doc, `workspace_doc_view_daily.total_views` is incremented by at
//!   least 1 — the fire-and-forget view-recording task must complete within a
//!   short grace period.
//!
//! Protocol (Engine.IO v4 + Socket.IO v4, long-polling transport):
//!   1. GET  /socket.io/?EIO=4&transport=polling                        (EIO open)
//!   2. POST /socket.io/?EIO=4&transport=polling&sid=<sid>  body: 40    (SIO connect)
//!   3. GET  /socket.io/?EIO=4&transport=polling&sid=<sid>              (read connect ACK)
//!   4. POST /socket.io/?EIO=4&transport=polling&sid=<sid>  body: 421[<payload>] (emitWithAck)
//!   5. GET  /socket.io/?EIO=4&transport=polling&sid=<sid>              (read ACK response)
//!   6. tokio::sleep(150ms) — let the fire-and-forget view task complete
//!   7. DB assertion: workspace_doc_view_daily.total_views >= 1

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use sqlx::Row;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Engine.IO / Socket.IO polling helpers (mirrors socketio_auth_test.rs)
// ---------------------------------------------------------------------------

/// Engine.IO handshake — returns the transport `sid`.
async fn eio_handshake(app: &axum::Router, cookie: &str) -> String {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .header("cookie", cookie)
        .body(Body::empty())
        .expect("build EIO handshake request"),
    )
    .await
    .expect("EIO handshake request");

  assert_eq!(resp.status().as_u16(), 200, "EIO handshake must return 200");
  let body = resp.into_body().collect().await.expect("collect EIO body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let json_start = text.find('{').expect("no JSON in EIO open packet");
  let json_end = text.rfind('}').expect("no closing brace in EIO packet") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[json_start..json_end]).expect("invalid EIO JSON");
  json["sid"].as_str().expect("missing sid in EIO open").to_string()
}

/// Send a raw Socket.IO POST frame.
async fn sio_post(app: &axum::Router, sid: &str, cookie: &str, body: &str) {
  let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
  app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri(&uri)
        .header("content-type", "text/plain;charset=UTF-8")
        .header("cookie", cookie)
        .body(Body::from(body.to_string()))
        .expect("build SIO POST request"),
    )
    .await
    .expect("SIO POST request");
}

/// Poll for pending server packets. Handles Engine.IO ping/pong cycles.
/// Returns the raw body text once a Socket.IO message is found or after max polls.
async fn sio_poll(app: &axum::Router, sid: &str, cookie: &str) -> String {
  const MAX_POLLS: usize = 12;
  for _ in 0..MAX_POLLS {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let resp = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(&uri)
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build SIO GET request"),
      )
      .await
      .expect("SIO GET request");
    let body = resp
      .into_body()
      .collect()
      .await
      .expect("collect SIO poll body")
      .to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();

    // Socket.IO event ACK (43) or connect ACK (40) or event (42)
    if text.contains("40{") || text.contains("43") || text.contains("42") {
      return text;
    }

    // Engine.IO ping — respond with pong
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3").await;
      continue;
    }

    // Engine.IO noop (6) — poll again
    if text == "6" || text.contains(":6") {
      continue;
    }

    return text;
  }
  String::new()
}

// ---------------------------------------------------------------------------
// P83-C-01 test
// ---------------------------------------------------------------------------

/// INV-WS-VIEW-01: sending `space:load-doc` via Socket.IO increments
/// `workspace_doc_view_daily.total_views` for the target doc.
#[tokio::test]
async fn inv_ws_view_tracking_increments_on_doc_load() {
  let (app, pool, auth_store) = helpers::setup_app().await;

  // Seed: user owns a workspace and has a doc
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "wsview").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;

  let cookie = format!("affine_session={session_id}");

  // Step 1: Engine.IO handshake
  let sid = eio_handshake(&app, &cookie).await;

  // Step 2: Socket.IO namespace connect (POST "40")
  sio_post(&app, &sid, &cookie, "40").await;

  // Step 3: Read namespace connect ACK (expects "40{...}")
  let connect_resp = sio_poll(&app, &sid, &cookie).await;
  assert!(
    connect_resp.contains("40") || connect_resp.contains("40{"),
    "expected SIO namespace connect ACK, got: {connect_resp}"
  );
  assert!(
    !connect_resp.contains("AUTHENTICATION_REQUIRED"),
    "session cookie must authenticate successfully"
  );

  // Step 4: Emit `space:load-doc` with ack ID = 1
  // Socket.IO emitWithAck frame: "421[\"space:load-doc\", {payload}]"
  let load_doc_payload = serde_json::json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string()
  });
  let sio_frame = format!(r#"421["space:load-doc",{}]"#, load_doc_payload);
  sio_post(&app, &sid, &cookie, &sio_frame).await;

  // Step 5: Read the ack response (Socket.IO ACK frame starts with "431")
  let ack_resp = sio_poll(&app, &sid, &cookie).await;
  // The server returns either the doc data or a DOC_NOT_FOUND error.
  // Both paths still trigger view tracking (fire-and-forget after the ack).
  // If it's DOC_NOT_FOUND that's fine for this invariant — the doc exists in DB.
  let _ = ack_resp; // We don't assert on the ack content for this invariant

  // Step 6: Wait for the fire-and-forget tokio::spawn to complete.
  // The view tracking task is async; 200ms is generous for a local DB.
  sleep(Duration::from_millis(200)).await;

  // Step 7: INV-WS-VIEW-01 — verify daily view counter incremented
  let row = sqlx::query(
    r#"SELECT total_views FROM workspace_doc_view_daily
       WHERE workspace_id = $1 AND doc_id = $2"#,
  )
  .bind(workspace_id)
  .bind(doc_id.to_string())
  .fetch_optional(&pool)
  .await
  .expect("DB query for view tracking must succeed");

  assert!(
    row.is_some(),
    "INV-WS-VIEW-01: workspace_doc_view_daily row must exist after space:load-doc — view tracking broken"
  );
  let total_views: i64 = row.expect("row exists").get("total_views");
  assert!(
    total_views >= 1,
    "INV-WS-VIEW-01: total_views must be >= 1 after space:load-doc, got: {total_views}"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspace_doc_view_daily WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}
