//! Integration tests for the Socket.io WebSocket protocol (join, sync, awareness).
use crate::helpers;

// The transport journey exercises the current client. Dedicated room-version
// unit tests own historical protocol thresholds.
const CURRENT_SYNC_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::{
  build_router_for_integration_tests, build_router_for_websocket_integration_tests as build_router,
  config::AppConfig,
  document_broadcast_outbox::{SocketWorkspaceDocumentBroadcastPublisher, process_next_workspace_doc_broadcast},
  state::ApiState,
  websocket::{SocketCalendarBroadcast, redis_adapter::RedisWsAdapter},
};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::AuthService;
use myoxus_application::calendar::CalendarBroadcastPort;
use myoxus_application::doc::DocService;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::redis::RedisAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use tower::ServiceExt;

async fn eio_handshake(app: &axum::Router, cookie: &str) -> String {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/socket.io/?EIO=4&transport=polling")
        .header("cookie", cookie)
        .body(Body::empty())
        .expect("build Engine.IO handshake"),
    )
    .await
    .expect("Engine.IO handshake");
  let body = response.into_body().collect().await.expect("handshake body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let start = text.find('{').expect("handshake JSON start");
  let end = text.rfind('}').expect("handshake JSON end") + 1;
  let packet: Value = serde_json::from_str(&text[start..end]).expect("Engine.IO handshake JSON");
  packet["sid"].as_str().expect("Engine.IO sid").to_string()
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
        .expect("build Socket.IO POST"),
    )
    .await
    .expect("Socket.IO POST");
  assert_eq!(response.status().as_u16(), 200);
}

async fn sio_poll_until(app: &axum::Router, sid: &str, cookie: &str, needle: &str) -> String {
  for _ in 0..32 {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build Socket.IO poll"),
      )
      .await
      .expect("Socket.IO poll");
    let body = response.into_body().collect().await.expect("poll body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();
    if text.contains(needle) {
      return text;
    }
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3".to_string()).await;
    }
    sleep(Duration::from_millis(15)).await;
  }
  panic!("Socket.IO poll did not receive {needle}");
}

async fn sio_poll_until_without(
  app: &axum::Router,
  sid: &str,
  cookie: &str,
  expected: &str,
  forbidden: &str,
) -> String {
  for _ in 0..32 {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build Socket.IO poll"),
      )
      .await
      .expect("Socket.IO poll");
    let body = response.into_body().collect().await.expect("poll body").to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();
    assert!(
      !text.contains(forbidden),
      "socket {sid} received workspace-foreign event {forbidden}: {text}"
    );
    if text.contains(expected) {
      return text;
    }
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3".to_string()).await;
    }
    sleep(Duration::from_millis(15)).await;
  }
  panic!("Socket.IO poll did not receive {expected}");
}

async fn sio_emit_with_ack(
  app: &axum::Router,
  sid: &str,
  cookie: &str,
  ack_id: u64,
  event: &str,
  payload: Value,
  expected: &str,
) -> String {
  sio_post(app, sid, cookie, format!("42{ack_id}{}", json!([event, payload]))).await;
  sio_poll_until(app, sid, cookie, expected).await
}

async fn connect_workspace_client(app: &axum::Router, cookie: &str, workspace_id: uuid::Uuid, ack_id: u64) -> String {
  let sid = eio_handshake(app, cookie).await;
  sio_post(app, &sid, cookie, "40".to_string()).await;
  sio_poll_until(app, &sid, cookie, "40").await;
  let joined = sio_emit_with_ack(
    app,
    &sid,
    cookie,
    ack_id,
    "space:join",
    json!({
      "spaceType": "workspace",
      "spaceId": workspace_id,
      "clientVersion": CURRENT_SYNC_CLIENT_VERSION
    }),
    "success",
  )
  .await;
  assert!(joined.contains("success"), "workspace join must succeed: {joined}");
  sid
}

async fn assert_broadcast_for_both_clients(
  app: &axum::Router,
  cookie: &str,
  clients: [&str; 2],
  expected_document_keys: &[String],
) {
  for sid in clients {
    let packet = sio_poll_until(app, sid, cookie, "space:broadcast-doc-updates").await;
    for document_key in expected_document_keys {
      assert!(
        packet.contains(document_key),
        "client {sid} did not receive lifecycle delta for {document_key}: {packet}"
      );
    }
  }
}

async fn setup_app(with_socket_runtime: bool) -> (axum::Router, Arc<ApiState>, PgPool, Arc<SqlxAuthStore>) {
  let pool = helpers::setup_pool().await;

  let config = AppConfig::load().expect("load config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));

  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("DB operation"));

  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(myoxus_infrastructure::mail::LogMailAdapter),
    storage.clone(),
    3600,
    3600,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_service = Arc::new(BlobService::new(
    blob_store,
    storage.clone(),
    "test-sign-key".to_string(),
  ));

  let mut state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  );
  if with_socket_runtime {
    let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
    let redis = Arc::new(
      RedisAdapter::new(redis_url, format!("websocket-protocol-{}", uuid::Uuid::new_v4()))
        .expect("Socket.IO test Redis adapter"),
    );
    state = state
      .with_metrics_pool(pool.clone())
      .with_redis_ws_adapter(Arc::new(RedisWsAdapter::new(uuid::Uuid::new_v4(), redis)));
  }
  let state = Arc::new(state);
  let router = if with_socket_runtime {
    build_router((*state).clone())
  } else {
    build_router_for_integration_tests((*state).clone())
  };
  (router, state, pool, auth_store)
}

#[tokio::test]
async fn test_websocket_protocol_hardening() {
  let (_app, state, _pool, _auth_store) = setup_app(false).await;
  let admin = state
    .auth()
    .store
    .fulfill_user("ws_hardened@example.com", Some("WS Admin"), None)
    .await
    .expect("DB operation");
  let guest = state
    .auth()
    .store
    .fulfill_user("ws_guest@example.com", Some("WS Guest"), None)
    .await
    .expect("DB operation");
  let ws = state
    .workspace()
    .create_workspace(admin.id, None, None)
    .await
    .expect("DB operation");

  // 1. Test Userspace Access Control
  // Admin can access their own userspace
  // In our implementation, space_id for userspace IS the user_id.
  // (Simulated via internal call to assert_accessible logic)
  // We can't easily test socket.io state machine from outside without a full client,
  // but we can verify the business logic integration.

  let doc = state
    .doc()
    .create_page(ws.id, admin.id, Some("Hardened Page".into()))
    .await
    .expect("DB operation");

  // 2. Verify metadata loading works
  let meta = state
    .doc()
    .get_metadata(doc.id)
    .await
    .expect("DB operation")
    .expect("DB operation");
  assert_eq!(meta.title, "Hardened Page");
  assert!(!meta.blocked);

  // 3. Test Userspace creation
  let u_doc = state
    .doc()
    .create_userspace_doc(admin.id, Some("Private".into()))
    .await
    .expect("DB operation");
  assert_eq!(u_doc.userspace_owner_id, Some(admin.id));
  assert_eq!(u_doc.workspace_id, None);

  // 4. Workspace Sync permission parity (guest is not a member and cannot sync)
  let pc = state.permission_service();
  assert!(
    pc.can(
      &WorkspaceResource {
        user_id: admin.id,
        workspace_id: ws.id
      },
      WorkspaceAction::Sync
    )
    .await
  );
  assert!(
    !pc
      .can(
        &WorkspaceResource {
          user_id: guest.id,
          workspace_id: ws.id
        },
        WorkspaceAction::Sync
      )
      .await
  );
}

#[tokio::test]
async fn page_lifecycle_outbox_reaches_two_connected_clients_without_reload() {
  let (app, state, pool, auth_store) = setup_app(true).await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "mcp_lifecycle_live").await;
  let workspace = state
    .workspace()
    .create_workspace(user_id, Some("MCP lifecycle live".to_string()), None)
    .await
    .expect("create live workspace");
  let cookie = format!("affine_session={session_id}");
  let first = connect_workspace_client(&app, &cookie, workspace.id, 1).await;
  let second = connect_workspace_client(&app, &cookie, workspace.id, 1).await;
  sqlx::query("UPDATE outbox_events SET processed_at = now() WHERE processed_at IS NULL")
    .execute(&pool)
    .await
    .expect("isolate lifecycle fanout");
  let publisher = SocketWorkspaceDocumentBroadcastPublisher::new(state.as_ref());

  let created = state
    .doc()
    .create_page_lifecycle(workspace.id, user_id, Some("Live page".to_string()), None)
    .await
    .expect("create page lifecycle");
  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("publish create event")
  );
  assert_broadcast_for_both_clients(
    &app,
    &cookie,
    [&first, &second],
    &[created.document.external_id.clone(), workspace.id.to_string()],
  )
  .await;

  state
    .doc()
    .rename_page(
      workspace.id,
      created.document.id,
      user_id,
      "Live renamed page".to_string(),
      None,
    )
    .await
    .expect("rename page lifecycle");
  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("publish rename event")
  );
  assert_broadcast_for_both_clients(
    &app,
    &cookie,
    [&first, &second],
    &[created.document.external_id.clone(), workspace.id.to_string()],
  )
  .await;

  state
    .doc()
    .trash_page(workspace.id, created.document.id, user_id)
    .await
    .expect("trash page lifecycle");
  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("publish trash event")
  );
  assert_broadcast_for_both_clients(&app, &cookie, [&first, &second], &[workspace.id.to_string()]).await;

  state
    .doc()
    .restore_page(workspace.id, created.document.id, user_id)
    .await
    .expect("restore page lifecycle");
  assert!(
    process_next_workspace_doc_broadcast(&pool, &publisher)
      .await
      .expect("publish restore event")
  );
  assert_broadcast_for_both_clients(&app, &cookie, [&first, &second], &[workspace.id.to_string()]).await;

  helpers::cleanup_workspaces(&pool, &[workspace.id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn calendar_room_fanout_reaches_only_joined_workspace_clients() {
  let (app, state, pool, auth_store) = setup_app(true).await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "calendar_room_fanout").await;
  let first_workspace = state
    .workspace()
    .create_workspace(user_id, Some("Calendar room one".to_string()), None)
    .await
    .expect("first workspace");
  let second_workspace = state
    .workspace()
    .create_workspace(user_id, Some("Calendar room two".to_string()), None)
    .await
    .expect("second workspace");
  let cookie = format!("affine_session={session_id}");
  let first_client = connect_workspace_client(&app, &cookie, first_workspace.id, 1).await;
  let second_client = connect_workspace_client(&app, &cookie, first_workspace.id, 1).await;
  let foreign_client = connect_workspace_client(&app, &cookie, second_workspace.id, 1).await;
  let broadcaster = SocketCalendarBroadcast::new(state.redis_ws_adapter().cloned(), state.socket_io.clone());

  let first_event_id = uuid::Uuid::new_v4();
  broadcaster
    .broadcast_event_changed(first_workspace.id, first_event_id, "updated")
    .await;
  for sid in [&first_client, &second_client] {
    let packet = sio_poll_until(&app, sid, &cookie, &first_event_id.to_string()).await;
    assert!(
      packet.contains("calendar:event_changed") && packet.contains("\"op\":\"updated\""),
      "workspace client must receive the complete Calendar envelope: {packet}"
    );
  }

  let second_event_id = uuid::Uuid::new_v4();
  broadcaster
    .broadcast_event_changed(second_workspace.id, second_event_id, "created")
    .await;
  let foreign_packet = sio_poll_until_without(
    &app,
    &foreign_client,
    &cookie,
    &second_event_id.to_string(),
    &first_event_id.to_string(),
  )
  .await;
  assert!(
    foreign_packet.contains("calendar:event_changed") && foreign_packet.contains("\"op\":\"created\""),
    "second workspace client must receive only its own Calendar envelope: {foreign_packet}"
  );

  helpers::cleanup_workspaces(&pool, &[first_workspace.id, second_workspace.id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn websocket_sync_updates_and_timestamps_roundtrip() {
  let (_app, state, pool, _auth_store) = setup_app(false).await;
  let run_id = uuid::Uuid::new_v4();
  let admin = state
    .auth()
    .store
    .fulfill_user(
      &format!("ws_sync_roundtrip_{run_id}@example.com"),
      Some("WS Sync"),
      None,
    )
    .await
    .expect("admin user");
  let ws = state
    .workspace()
    .create_workspace(admin.id, Some(format!("Sync WS {run_id}")), None)
    .await
    .expect("workspace");
  let doc = state
    .doc()
    .create_page(ws.id, admin.id, Some("Sync Doc".to_string()))
    .await
    .expect("doc");

  let update1 = yjs::merge_updates(vec![]).expect("empty yjs update");
  state
    .doc()
    .push_update(
      ws.id,
      doc.id,
      update1,
      0,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("push update1");

  let ts_before = chrono::Utc::now().timestamp_millis();
  sleep(Duration::from_millis(5)).await;

  let update2 = yjs::merge_updates(vec![]).expect("empty yjs update");
  state
    .doc()
    .push_update(
      ws.id,
      doc.id,
      update2,
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .expect("push update2");

  let loaded = state.doc().load_full_doc(ws.id, doc.id).await.expect("load full doc");
  assert!(!loaded.is_empty(), "merged sync payload should not be empty");

  let all_timestamps = state
    .doc()
    .get_space_doc_timestamps(ws.id, None)
    .await
    .expect("timestamps");
  assert!(
    all_timestamps.contains_key(&doc.id.to_string()),
    "sync doc must appear in workspace timestamp index"
  );

  let filtered = state
    .doc()
    .get_space_doc_timestamps(ws.id, Some(ts_before))
    .await
    .expect("filtered timestamps");
  assert!(
    filtered.contains_key(&doc.id.to_string()),
    "sync doc must be returned after timestamp filter"
  );

  helpers::cleanup_workspaces(&pool, &[ws.id]).await;
  helpers::cleanup_users(&pool, &[admin.id]).await;
}

/// INV-DOC-USERSPACE-01: Userspace doc updates must persist in doc_updates with
/// workspace_id = personal workspace UUID (not user UUID).  Regression test for
/// the FK violation fixed in P101-WS-FK-01.
#[tokio::test]
async fn inv_doc_userspace01_push_update_uses_personal_workspace_id() {
  let (_app, state, pool, _auth_store) = setup_app(false).await;
  let user = state
    .auth()
    .store
    .fulfill_user("ws_userspace_fk@example.com", Some("FK Test"), None)
    .await
    .expect("create user");
  let personal_ws = state
    .workspace()
    .create_workspace(user.id, Some("Personal".into()), None)
    .await
    .expect("personal workspace");

  let doc_id = uuid::Uuid::new_v4();
  let payload = yjs::merge_updates(vec![]).expect("empty yjs");
  // push_update with Userspace: workspace_id parameter carries the USER uuid
  state
    .doc()
    .push_update(
      user.id,
      doc_id,
      payload,
      0,
      myoxus_application::doc::DocSpaceKind::Userspace,
    )
    .await
    .expect("push_update must not FK-violate");

  // Verify: doc_updates.workspace_id must be the personal workspace, not user UUID
  let stored_ws_id: uuid::Uuid = sqlx::query_scalar("SELECT workspace_id FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("doc_updates row must exist");
  assert_eq!(
    stored_ws_id, personal_ws.id,
    "doc_updates.workspace_id must be personal workspace, not user UUID"
  );
  assert_ne!(stored_ws_id, user.id, "doc_updates.workspace_id must NOT be user UUID");
  // Space kind owns this distinction even when private content carries page intent.
  let private_key = format!("private-{}", uuid::Uuid::new_v4());
  let private_doc = yrs::Doc::new();
  let private_payload = {
    use yrs::{Map, ReadTxn, Transact};
    let meta = private_doc.get_or_insert_map("meta");
    let mut tx = private_doc.transact_mut();
    meta.insert(&mut tx, "pageCreationId", private_key.as_str());
    meta.insert(&mut tx, "pageCreationIntent", "private-content");
    tx.encode_state_as_update_v1(&Default::default())
  };
  state
    .doc()
    .push_external_update_raw(
      user.id,
      myoxus_domain::document_key::DocumentKey::parse(private_key).unwrap(),
      private_payload,
      myoxus_application::doc::DocSpaceKind::Userspace,
    )
    .await
    .expect("userspace external first upload");
  let registrations: i64 = sqlx::query_scalar("SELECT count(*) FROM page_registration_evidence WHERE workspace_id=$1")
    .bind(stored_ws_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(registrations, 0, "userspace storage must not register workspace pages");

  // Cleanup
  sqlx::query("DELETE FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(personal_ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(personal_ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(personal_ws.id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user.id)
    .execute(&pool)
    .await
    .ok();
}
