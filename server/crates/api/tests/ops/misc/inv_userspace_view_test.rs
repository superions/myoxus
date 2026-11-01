//! P96-F1 — Invariant test: userspace doc load must NOT trigger view tracking.
//!
//! Invariant (INV-F1):
//!   When a Socket.IO client loads a doc with spaceType=userspace, the server
//!   must NOT insert rows into `workspace_doc_view_daily` or
//!   `workspace_member_last_access`.  Before the fix, the fire-and-forget spawn
//!   ran unconditionally and hit FK constraint failures for userspace space IDs.

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Minimal Socket.IO polling helpers (copied pattern from
// doc_view_tracking_ws_e2e_test.rs)
// ---------------------------------------------------------------------------

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
    .expect("EIO handshake");
  assert_eq!(resp.status().as_u16(), 200, "EIO handshake must succeed");
  let body = resp.into_body().collect().await.expect("EIO body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let s = text.find('{').expect("no JSON in EIO open");
  let e = text.rfind('}').expect("no closing brace") + 1;
  let json: serde_json::Value = serde_json::from_str(&text[s..e]).expect("EIO JSON");
  json["sid"].as_str().expect("missing sid").to_string()
}

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
        .expect("build SIO POST"),
    )
    .await
    .expect("SIO POST");
}

async fn sio_poll(app: &axum::Router, sid: &str, cookie: &str) -> String {
  for _ in 0..12usize {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let resp = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(&uri)
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build SIO GET"),
      )
      .await
      .expect("SIO GET");
    let body = resp.into_body().collect().await.expect("body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();
    if text.contains("40{") || text.contains("43") || text.contains("42") {
      return text;
    }
    if text == "2" || text.contains(":2") {
      sio_post(app, sid, cookie, "3").await;
      continue;
    }
  }
  String::new()
}

// ---------------------------------------------------------------------------
// INV-F1 test
// ---------------------------------------------------------------------------

/// INV-F1: loading a doc with spaceType=userspace must NOT write to
/// workspace_doc_view_daily or workspace_member_last_access.
#[tokio::test]
async fn inv_f1_userspace_doc_view_no_tracking() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "f1user").await;

  // The userspace "workspace_id" is the user's own ID — no workspace row exists.
  let userspace_id = user_id;
  // Use a random doc ID that also has no backing row.
  let userspace_doc_id = uuid::Uuid::new_v4();
  let cookie = format!("affine_session={session_id}");

  // EIO handshake
  let sid = eio_handshake(&app, &cookie).await;

  // SIO namespace connect
  sio_post(&app, &sid, &cookie, "40").await;
  let connect_resp = sio_poll(&app, &sid, &cookie).await;
  assert!(
    !connect_resp.contains("AUTHENTICATION_REQUIRED"),
    "must authenticate, got: {connect_resp}"
  );

  // Emit space:load-doc with spaceType=userspace
  let frame = format!(
    r#"421["space:load-doc",{{"spaceType":"userspace","spaceId":"{}","docId":"{}"}}]"#,
    userspace_id, userspace_doc_id
  );
  sio_post(&app, &sid, &cookie, &frame).await;
  // Drain the ACK
  let _ = sio_poll(&app, &sid, &cookie).await;

  // Wait for any fire-and-forget tasks that might have been spawned.
  sleep(Duration::from_millis(200)).await;

  // INV-F1: no view tracking rows must exist for the userspace ID
  let view_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_doc_view_daily WHERE workspace_id = $1")
    .bind(userspace_id)
    .fetch_one(&pool)
    .await
    .expect("view count query");
  assert_eq!(
    view_count, 0,
    "INV-F1: workspace_doc_view_daily must have no rows for userspace doc, got: {view_count}"
  );

  let access_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM workspace_member_last_access WHERE workspace_id = $1")
      .bind(userspace_id)
      .fetch_one(&pool)
      .await
      .expect("access count query");
  assert_eq!(
    access_count, 0,
    "INV-F1: workspace_member_last_access must have no rows for userspace doc, got: {access_count}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
