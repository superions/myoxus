// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! P0-02 event-level ACL regressions over the real Socket.IO transport.
//!
//! The room membership is intentionally kept open while roles change. Every
//! assertion therefore proves the next event re-enters the server ACL path
//! instead of trusting a successful `space:join`.

use crate::helpers;

// This ACL journey represents the current Web client. Historical protocol
// routing has dedicated unit coverage and must not leak into authorization
// fixtures as a stale, eventually unsupported release number.
const CURRENT_SYNC_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
use axum::{body::Body, http::Request};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::json;
use sqlx::{PgPool, Row};
use std::sync::Arc;
use tokio::time::{Duration, sleep, timeout};
use tower::ServiceExt;
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, Transact};

async fn add_workspace_role(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(role)
  .execute(pool)
  .await
  .expect("workspace role must be persisted");
}

fn valid_update_base64() -> String {
  let doc = Doc::new();
  let metadata = doc.get_or_insert_map("p0_acl");
  let mut txn = doc.transact_mut();
  metadata.insert(&mut txn, "probe", Any::String("authorized".into()));
  drop(txn);
  STANDARD.encode(doc.transact().encode_state_as_update_v1(&yrs::StateVector::default()))
}

async fn seed_doc_update(pool: &PgPool, workspace_id: Uuid, doc_id: Uuid) {
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let doc = Doc::new();
  let map = doc.get_or_insert_map("p0_seed");
  let mut txn = doc.transact_mut();
  map.insert(&mut txn, "content", Any::String("seed".into()));
  drop(txn);
  let update = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
  service
    .push_update(
      workspace_id,
      doc_id,
      update,
      chrono::Utc::now().timestamp_millis(),
      DocSpaceKind::Workspace,
    )
    .await
    .expect("seed document update");
}

async fn eio_handshake(app: &axum::Router, cookie: &str) -> String {
  let response = app
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
  assert_eq!(response.status().as_u16(), 200, "EIO handshake must succeed");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect EIO body")
    .to_bytes();
  let text = String::from_utf8_lossy(&body);
  let start = text.find('{').expect("EIO body must contain JSON");
  let end = text.rfind('}').expect("EIO body must contain closing JSON") + 1;
  let packet: serde_json::Value = serde_json::from_str(&text[start..end]).expect("valid EIO open packet");
  packet["sid"].as_str().expect("EIO sid").to_string()
}

async fn sio_post(app: &axum::Router, sid: &str, cookie: &str, body: String) {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
        .header("content-type", "text/plain;charset=UTF-8")
        .header("cookie", cookie)
        .body(Body::from(body))
        .expect("build SIO POST request"),
    )
    .await
    .expect("SIO POST request");
  assert_eq!(response.status().as_u16(), 200, "SIO POST must be accepted");
}

async fn sio_poll_for(app: &axum::Router, sid: &str, cookie: &str, needles: &[&str]) -> String {
  for _ in 0..24 {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build SIO poll request"),
      )
      .await
      .expect("SIO poll request");
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect SIO body")
      .to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();
    if needles.iter().any(|needle| text.contains(needle)) {
      return text;
    }
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3".to_string()).await;
    }
    sleep(Duration::from_millis(15)).await;
  }
  panic!("SIO poll did not receive one of {needles:?}");
}

async fn sio_connect_and_join(app: &axum::Router, cookie: &str, workspace_id: Uuid) -> String {
  let sid = eio_handshake(app, cookie).await;
  sio_post(app, &sid, cookie, "40".to_string()).await;
  let connected = sio_poll_for(app, &sid, cookie, &["40"]).await;
  assert!(
    connected.contains("40"),
    "Socket.IO namespace must connect: {connected}"
  );
  let payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "clientVersion": CURRENT_SYNC_CLIENT_VERSION
  });
  sio_post(app, &sid, cookie, format!(r#"421["space:join",{}]"#, payload)).await;
  let joined = sio_poll_for(app, &sid, cookie, &["431"]).await;
  assert!(joined.contains("success\":true"), "space:join must succeed: {joined}");
  sid
}

async fn sio_connect_userspace(app: &axum::Router, cookie: &str, owner_id: Uuid) -> String {
  let sid = eio_handshake(app, cookie).await;
  sio_post(app, &sid, cookie, "40".to_string()).await;
  let connected = sio_poll_for(app, &sid, cookie, &["40"]).await;
  assert!(connected.contains("40"), "userspace socket must connect: {connected}");
  let payload = json!({
    "spaceType": "userspace",
    "spaceId": owner_id.to_string(),
    "clientVersion": CURRENT_SYNC_CLIENT_VERSION
  });
  sio_post(app, &sid, cookie, format!(r#"421["space:join",{}]"#, payload)).await;
  sid
}

async fn send_push(app: &axum::Router, sid: &str, cookie: &str, workspace_id: Uuid, doc_id: Uuid, update: &str) {
  let payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "update": update
  });
  sio_post(app, sid, cookie, format!(r#"422["space:push-doc-update",{}]"#, payload)).await;
}

async fn send_load(app: &axum::Router, sid: &str, cookie: &str, workspace_id: Uuid, doc_id: Uuid) -> String {
  let payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string()
  });
  sio_post(app, sid, cookie, format!(r#"421["space:load-doc",{}]"#, payload)).await;
  sio_poll_for(app, sid, cookie, &["431", "ACCESS_DENIED"]).await
}

/// Shared protocol assertion used by the transport matrix: timestamp maps
/// must not be exposed to a workspace member that cannot sync documents.
pub(crate) async fn assert_workspace_timestamp_denied(app: &axum::Router, cookie: &str, workspace_id: Uuid) {
  let sid = eio_handshake(app, cookie).await;
  sio_post(app, &sid, cookie, "40".to_string()).await;
  let connected = sio_poll_for(app, &sid, cookie, &["40"]).await;
  assert!(
    connected.contains("40"),
    "timestamp test socket must connect: {connected}"
  );
  let payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "timestamp": null
  });
  sio_post(
    app,
    &sid,
    cookie,
    format!(r#"421["space:load-doc-timestamps",{}]"#, payload),
  )
  .await;
  let denied = sio_poll_for(app, &sid, cookie, &["ACCESS_DENIED"]).await;
  assert!(
    denied.contains("ACCESS_DENIED"),
    "timestamp map must be denied: {denied}"
  );
}

/// A Reader can load a document but an already authenticated socket cannot
/// use the room membership to push or permanently delete it.
#[test]
fn reader_can_load_but_cannot_push_or_delete() {
  helpers::block_on_large_stack("p002-reader-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "p002_reader_owner").await;
    let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "p002_reader").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, reader_id, "Reader").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    seed_doc_update(&pool, workspace_id, doc_id).await;

    let cookie = format!("affine_session={reader_session}");
    let sid = sio_connect_and_join(&app, &cookie, workspace_id).await;
    let load_ack = send_load(&app, &sid, &cookie, workspace_id, doc_id).await;
    assert!(
      load_ack.contains("data"),
      "Reader load must return document data: {load_ack}"
    );

    let update_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count before denied push");
    send_push(&app, &sid, &cookie, workspace_id, doc_id, &valid_update_base64()).await;
    let denied_push = sio_poll_for(&app, &sid, &cookie, &["ACCESS_DENIED"]).await;
    assert!(
      denied_push.contains("ACCESS_DENIED"),
      "Reader push must be denied: {denied_push}"
    );
    let update_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count after denied push");
    assert_eq!(
      update_count_after, update_count_before,
      "denied push must not persist an update"
    );

    let delete_payload = json!({
      "spaceType": "workspace",
      "spaceId": workspace_id.to_string(),
      "docId": doc_id.to_string()
    });
    sio_post(
      &app,
      &sid,
      &cookie,
      format!(r#"42["space:delete-doc",{}]"#, delete_payload),
    )
    .await;
    sleep(Duration::from_millis(100)).await;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc existence after denied delete");
    assert!(exists, "Reader hard-delete must not remove the document");

    helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
  });
}

/// A Commenter may use comment capabilities but must not enter the Yjs update
/// path, even though workspace sync membership itself is allowed.
#[test]
fn commenter_cannot_push_yjs() {
  helpers::block_on_large_stack("p002-commenter-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "p002_commenter_owner").await;
    let (commenter_id, commenter_session) = helpers::seed_user(&pool, &auth_store, "p002_commenter").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, commenter_id, "Commenter").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

    let cookie = format!("affine_session={commenter_session}");
    let sid = sio_connect_and_join(&app, &cookie, workspace_id).await;
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count before commenter push");
    send_push(&app, &sid, &cookie, workspace_id, doc_id, &valid_update_base64()).await;
    let denied = sio_poll_for(&app, &sid, &cookie, &["ACCESS_DENIED"]).await;
    assert!(
      denied.contains("ACCESS_DENIED"),
      "Commenter Yjs push must be denied: {denied}"
    );
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count after commenter push");
    assert_eq!(after, before, "Commenter denial must happen before persistence");

    helpers::cleanup_users(&pool, &[owner_id, commenter_id]).await;
  });
}

/// A missing workspace document has no document ACL yet. Loading must expose
/// only DOC_NOT_FOUND, while its first push is authorized by CreateDoc. Once
/// materialized, the normal per-document ACL applies to every later event.
#[test]
fn first_push_materialization_requires_workspace_create_doc() {
  helpers::block_on_large_stack("p002-first-push-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_first_push_owner").await;
    let (collaborator_id, collaborator_session) =
      helpers::seed_user(&pool, &auth_store, "p002_first_push_collaborator").await;
    let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "p002_first_push_reader").await;
    let (commenter_id, commenter_session) = helpers::seed_user(&pool, &auth_store, "p002_first_push_commenter").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, collaborator_id, "Collaborator").await;
    add_workspace_role(&pool, workspace_id, reader_id, "Reader").await;
    add_workspace_role(&pool, workspace_id, commenter_id, "Commenter").await;

    let collaborator_cookie = format!("affine_session={collaborator_session}");
    let collaborator_sid = sio_connect_and_join(&app, &collaborator_cookie, workspace_id).await;
    let created_key = Uuid::new_v4();
    let missing_load = send_load(&app, &collaborator_sid, &collaborator_cookie, workspace_id, created_key).await;
    assert!(
      missing_load.contains("DOC_NOT_FOUND") && !missing_load.contains("ACCESS_DENIED"),
      "unknown load must preserve the empty-remote contract without disclosing data: {missing_load}"
    );
    let missing_doc_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND external_id = $2")
        .bind(workspace_id)
        .bind(created_key.to_string())
        .fetch_one(&pool)
        .await
        .expect("missing-load document count");
    assert_eq!(missing_doc_count, 0, "loading an unknown key must not materialize it");

    let owner_cookie = format!("affine_session={owner_session}");
    let observer_sid = sio_connect_and_join(&app, &owner_cookie, workspace_id).await;
    send_push(
      &app,
      &collaborator_sid,
      &collaborator_cookie,
      workspace_id,
      created_key,
      &valid_update_base64(),
    )
    .await;
    let accepted = sio_poll_for(
      &app,
      &collaborator_sid,
      &collaborator_cookie,
      &[
        "accepted",
        "ACCESS_DENIED",
        "PERMANENT_ERROR",
        "INTERNAL_ERROR",
        "INVALID_YJS_UPDATE",
      ],
    )
    .await;
    assert!(
      accepted.contains("accepted") && !accepted.contains("ACCESS_DENIED"),
      "Collaborator first push must be accepted: {accepted}"
    );
    let created_doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
      .bind(workspace_id)
      .bind(created_key.to_string())
      .fetch_one(&pool)
      .await
      .expect("accepted first push must materialize the external document key");
    let created_update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(created_doc_id)
      .fetch_one(&pool)
      .await
      .expect("materialized document update count");
    assert_eq!(
      created_update_count, 1,
      "first push must persist exactly one initial update"
    );
    let materialized_load = send_load(&app, &collaborator_sid, &collaborator_cookie, workspace_id, created_key).await;
    assert!(
      materialized_load.contains("data") && !materialized_load.contains("DOC_NOT_FOUND"),
      "materialized document must load through the normal read ACL: {materialized_load}"
    );
    let accepted_broadcast = sio_poll_for(
      &app,
      &observer_sid,
      &owner_cookie,
      &["space:broadcast-doc-update", "space:broadcast-doc-updates"],
    )
    .await;
    assert!(
      accepted_broadcast.contains(&created_key.to_string()),
      "the allowed first push must broadcast the materialized document key before denial checks: {accepted_broadcast}"
    );

    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(created_doc_id)
      .execute(&pool)
      .await
      .expect("soft-delete materialized document");
    send_push(
      &app,
      &collaborator_sid,
      &collaborator_cookie,
      workspace_id,
      created_key,
      &valid_update_base64(),
    )
    .await;
    let deleted_denial = sio_poll_for(
      &app,
      &collaborator_sid,
      &collaborator_cookie,
      &["ACCESS_DENIED", "accepted"],
    )
    .await;
    assert!(
      deleted_denial.contains("ACCESS_DENIED") && !deleted_denial.contains("accepted"),
      "soft-deleted documents must not fall back to CreateDoc: {deleted_denial}"
    );
    let deleted_update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(created_doc_id)
      .fetch_one(&pool)
      .await
      .expect("soft-deleted document update count");
    assert_eq!(
      deleted_update_count, 1,
      "denied soft-deleted push must preserve the initial update only"
    );
    let deleted_at_present: bool =
      sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM docs WHERE id = $1 AND workspace_id = $2")
        .bind(created_doc_id)
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("soft-deleted document lifecycle state");
    assert!(
      deleted_at_present,
      "denied push must not revive a soft-deleted document"
    );

    for (role, session) in [("Reader", reader_session), ("Commenter", commenter_session)] {
      let cookie = format!("affine_session={session}");
      let sid = sio_connect_and_join(&app, &cookie, workspace_id).await;
      let denied_key = Uuid::new_v4();
      let missing_load = send_load(&app, &sid, &cookie, workspace_id, denied_key).await;
      assert!(
        missing_load.contains("DOC_NOT_FOUND") && !missing_load.contains("ACCESS_DENIED"),
        "{role} unknown load must return only DOC_NOT_FOUND: {missing_load}"
      );
      send_push(&app, &sid, &cookie, workspace_id, denied_key, &valid_update_base64()).await;
      let denied = sio_poll_for(&app, &sid, &cookie, &["ACCESS_DENIED", "accepted"]).await;
      assert!(
        denied.contains("ACCESS_DENIED") && !denied.contains("accepted"),
        "{role} first push must be denied: {denied}"
      );
      let denied_doc_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id = $1 AND external_id = $2")
          .bind(workspace_id)
          .bind(denied_key.to_string())
          .fetch_one(&pool)
          .await
          .expect("denied document count");
      assert_eq!(
        denied_doc_count, 0,
        "{role} denial must happen before document persistence"
      );
      let denied_update_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.workspace_id = $1 AND d.external_id = $2",
      )
      .bind(workspace_id)
      .bind(denied_key.to_string())
      .fetch_one(&pool)
      .await
      .expect("denied update count");
      assert_eq!(
        denied_update_count, 0,
        "{role} denial must happen before update persistence"
      );
    }

    let observer_poll = timeout(Duration::from_millis(350), async {
      let response = app
        .clone()
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(format!("/socket.io/?EIO=4&transport=polling&sid={observer_sid}"))
            .header("cookie", &owner_cookie)
            .body(Body::empty())
            .expect("build first-push observer poll request"),
        )
        .await
        .expect("first-push observer poll request");
      String::from_utf8_lossy(
        &response
          .into_body()
          .collect()
          .await
          .expect("collect first-push observer poll")
          .to_bytes(),
      )
      .to_string()
    })
    .await;
    if let Ok(poll) = observer_poll {
      assert!(
        !poll.contains("space:broadcast-doc-update") && !poll.contains("space:broadcast-doc-updates"),
        "denied first pushes must not broadcast updates: {poll}"
      );
    }

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[owner_id, collaborator_id, reader_id, commenter_id]).await;
  });
}

/// Revoking the workspace's effective document-writing role takes effect on
/// the next event without disconnecting the already-open Socket.IO session.
#[test]
fn revoked_doc_role_blocks_next_event_on_open_socket() {
  helpers::block_on_large_stack("p002-revocation-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "p002_revoke_owner").await;
    let (editor_id, editor_session) = helpers::seed_user(&pool, &auth_store, "p002_revoke_editor").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, editor_id, "Collaborator").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let cookie = format!("affine_session={editor_session}");
    let sid = sio_connect_and_join(&app, &cookie, workspace_id).await;

    send_push(&app, &sid, &cookie, workspace_id, doc_id, &valid_update_base64()).await;
    let accepted = sio_poll_for(&app, &sid, &cookie, &["accepted"]).await;
    assert!(
      accepted.contains("accepted"),
      "initial editor push must succeed: {accepted}"
    );
    let before_revoke: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count before revoke");

    sqlx::query("UPDATE workspace_memberships SET role = 'Reader' WHERE workspace_id = $1 AND user_id = $2")
      .bind(workspace_id)
      .bind(editor_id)
      .execute(&pool)
      .await
      .expect("role revocation");

    send_push(&app, &sid, &cookie, workspace_id, doc_id, &valid_update_base64()).await;
    let denied = sio_poll_for(&app, &sid, &cookie, &["ACCESS_DENIED"]).await;
    assert!(
      denied.contains("ACCESS_DENIED"),
      "revoked socket push must be denied: {denied}"
    );
    let after_revoke: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count after revoke");
    assert_eq!(after_revoke, before_revoke, "revoked event must not persist an update");

    helpers::cleanup_users(&pool, &[owner_id, editor_id]).await;
  });
}

/// A denied event creates neither persistence nor a broadcast to another
/// socket in the same room.
#[test]
fn denied_doc_event_has_no_tracking_persistence_or_broadcast() {
  helpers::block_on_large_stack("p002-side-effects-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_sideeffect_owner").await;
    let (commenter_id, commenter_session) = helpers::seed_user(&pool, &auth_store, "p002_sideeffect_commenter").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, commenter_id, "Commenter").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let owner_cookie = format!("affine_session={owner_session}");
    let commenter_cookie = format!("affine_session={commenter_session}");
    let observer_sid = sio_connect_and_join(&app, &owner_cookie, workspace_id).await;
    let sender_sid = sio_connect_and_join(&app, &commenter_cookie, workspace_id).await;

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count before denied side-effect test");
    let views_before: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("view count before denied side-effect test");
    let member_access_before: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM workspace_member_last_access WHERE workspace_id = $1 AND user_id = $2")
        .bind(workspace_id)
        .bind(commenter_id)
        .fetch_one(&pool)
        .await
        .expect("member access count before denied side-effect test");
    send_push(
      &app,
      &sender_sid,
      &commenter_cookie,
      workspace_id,
      doc_id,
      &valid_update_base64(),
    )
    .await;
    let denied = sio_poll_for(&app, &sender_sid, &commenter_cookie, &["ACCESS_DENIED"]).await;
    assert!(
      denied.contains("ACCESS_DENIED"),
      "denied event must report ACCESS_DENIED: {denied}"
    );

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("doc update count after denied side-effect test");
    assert_eq!(after, before, "denied event must not persist an update");
    let views_after: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("view count after denied side-effect test");
    assert_eq!(views_after, views_before, "denied event must not track a document view");
    let member_access_after: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM workspace_member_last_access WHERE workspace_id = $1 AND user_id = $2")
        .bind(workspace_id)
        .bind(commenter_id)
        .fetch_one(&pool)
        .await
        .expect("member access count after denied side-effect test");
    assert_eq!(
      member_access_after, member_access_before,
      "denied event must not update last-access tracking"
    );

    let observer_poll = timeout(Duration::from_millis(350), async {
      let response = app
        .clone()
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(format!("/socket.io/?EIO=4&transport=polling&sid={observer_sid}"))
            .header("cookie", owner_cookie)
            .body(Body::empty())
            .expect("build observer poll request"),
        )
        .await
        .expect("observer poll request");
      String::from_utf8_lossy(
        &response
          .into_body()
          .collect()
          .await
          .expect("collect observer poll")
          .to_bytes(),
      )
      .to_string()
    })
    .await;
    if let Ok(poll) = observer_poll {
      assert!(
        !poll.contains("space:broadcast-doc-update"),
        "denied event must not broadcast an update: {poll}"
      );
    }

    helpers::cleanup_users(&pool, &[owner_id, commenter_id]).await;
  });
}

/// Userspace remains owner-only and does not accidentally inherit workspace
/// ACL behavior. The owner may perform the documented empty-first load;
/// another authenticated user cannot join that userspace.
#[test]
fn userspace_owner_only_remains_intact() {
  helpers::block_on_large_stack("p002-userspace-socket", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_userspace_owner").await;
    let (other_id, other_session) = helpers::seed_user(&pool, &auth_store, "p002_userspace_other").await;
    let owner_cookie = format!("affine_session={owner_session}");
    let other_cookie = format!("affine_session={other_session}");

    let owner_sid = sio_connect_userspace(&app, &owner_cookie, owner_id).await;
    let owner_join = sio_poll_for(&app, &owner_sid, &owner_cookie, &["431"]).await;
    assert!(
      owner_join.contains("success\":true"),
      "userspace owner join must succeed: {owner_join}"
    );
    let load = json!({
      "spaceType": "userspace",
      "spaceId": owner_id.to_string(),
      "docId": owner_id.to_string()
    });
    sio_post(
      &app,
      &owner_sid,
      &owner_cookie,
      format!(r#"421["space:load-doc",{}]"#, load),
    )
    .await;
    let load_ack = sio_poll_for(&app, &owner_sid, &owner_cookie, &["431"]).await;
    assert!(
      load_ack.contains("data"),
      "userspace owner empty-first load must succeed: {load_ack}"
    );

    let other_sid = sio_connect_userspace(&app, &other_cookie, owner_id).await;
    let denied_join = sio_poll_for(&app, &other_sid, &other_cookie, &["431", "SpaceAccessDenied"]).await;
    assert!(
      denied_join.contains("success\":false") || denied_join.contains("SpaceAccessDenied"),
      "non-owner userspace join must be denied: {denied_join}"
    );

    helpers::cleanup_users(&pool, &[owner_id, other_id]).await;
  });
}
