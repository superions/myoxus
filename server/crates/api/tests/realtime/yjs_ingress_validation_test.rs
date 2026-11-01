// SPDX-License-Identifier: AGPL-3.0-or-later

//! P-SRV-P0-AUDIT-04: external Yjs ingress over the real Socket.IO polling path.
//!
//! The test deliberately checks the transport adapter and the authoritative
//! application boundary together. Invalid Base64, invalid Yjs v1 bytes and an
//! oversized decoded payload must be rejected before `doc_updates` changes; the
//! smallest valid v1 update must still be accepted.

use axum::{body::Body, http::Request};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::time::{Instant, sleep, timeout};
use tower::ServiceExt;
use uuid::Uuid;
use yrs::{Doc, ReadTxn, Text, Transact};

use crate::helpers;

// These journeys exercise the currently shipped client, not the rejection path
// for pre-cutover releases. Deriving the value from the API package prevents a
// future release bump from silently turning this fixture into an unsupported
// client.
const CURRENT_SYNC_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

fn text_update(value: &str) -> Vec<u8> {
  let doc = Doc::new();
  let text = doc.get_or_insert_text("body");
  let mut txn = doc.transact_mut();
  text.insert(&mut txn, 0, value);
  txn.encode_update_v1()
}

fn insert_delete_updates(value: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
  let doc = Doc::new();
  let text = doc.get_or_insert_text("body");
  let insert = {
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, value);
    txn.encode_update_v1()
  };
  let delete = {
    let mut txn = doc.transact_mut();
    text.remove_range(&mut txn, 0, value.len() as u32);
    txn.encode_update_v1()
  };
  let complete = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
  (insert, delete, complete)
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
        .expect("build Engine.IO handshake"),
    )
    .await
    .expect("Engine.IO handshake");
  assert_eq!(response.status().as_u16(), 200);
  let body = response.into_body().collect().await.expect("handshake body").to_bytes();
  let text = String::from_utf8_lossy(&body);
  let start = text.find('{').expect("handshake JSON start");
  let end = text.rfind('}').expect("handshake JSON end") + 1;
  let packet: Value = serde_json::from_str(&text[start..end]).expect("handshake JSON");
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
          .method("GET")
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

async fn sio_poll_bounded(app: &axum::Router, sid: &str, cookie: &str, wait: Duration) -> Option<String> {
  let response = match timeout(
    wait,
    app.clone().oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
        .header("cookie", cookie)
        .body(Body::empty())
        .expect("build bounded Socket.IO poll"),
    ),
  )
  .await
  {
    Ok(response) => response.expect("bounded Socket.IO poll"),
    Err(_) => return None,
  };
  let body = response
    .into_body()
    .collect()
    .await
    .expect("bounded poll body")
    .to_bytes();
  Some(String::from_utf8_lossy(&body).to_string())
}

async fn sio_collect_ack_range(app: &axum::Router, sid: &str, cookie: &str, first_ack_id: u64, last_ack_id: u64) {
  let mut remaining = (first_ack_id..=last_ack_id).collect::<BTreeSet<_>>();
  let deadline = Instant::now() + Duration::from_secs(15);
  while !remaining.is_empty() {
    let wait = deadline.saturating_duration_since(Instant::now());
    assert!(!wait.is_zero(), "Socket.IO ACKs did not arrive: {remaining:?}");
    let response = sio_poll_bounded(app, sid, cookie, wait.min(Duration::from_secs(5)))
      .await
      .unwrap_or_else(|| panic!("Socket.IO ACKs did not arrive: {remaining:?}"));
    for packet in response.split('\u{1e}') {
      if packet == "2" {
        sio_post(app, sid, cookie, "3".to_string()).await;
        continue;
      }
      let Some(payload) = packet.strip_prefix("43") else {
        continue;
      };
      let id_end = payload
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(payload.len());
      if let Ok(ack_id) = payload[..id_end].parse::<u64>() {
        if remaining.contains(&ack_id) {
          assert!(
            packet.contains(r#""accepted":true"#),
            "Socket.IO replay {ack_id} was acknowledged without acceptance: {packet}"
          );
        }
        remaining.remove(&ack_id);
      }
    }
  }
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

#[tokio::test]
async fn websocket_moved_source_is_not_missing_or_recreatable() {
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "moved_source").await;
  let source = helpers::create_workspace(&pool, user_id).await;
  let target = helpers::create_workspace(&pool, user_id).await;
  let operation = Uuid::new_v4();
  let key = "moved-source-key";
  // Publication persistence is covered by its repository journey. This fixture
  // exercises its durable retirement evidence through the actual client transport.
  sqlx::query("INSERT INTO workspace_content_operations (id, idempotency_id, actor_id, kind, source_workspace_id, target_workspace_id, status, manifest_hash) VALUES ($1, $1, $2, 'move', $3, $4, 'succeeded', $5)")
    .bind(operation).bind(user_id).bind(source).bind(target).bind("a".repeat(64))
    .execute(&pool).await.expect("seed published move");
  sqlx::query("INSERT INTO workspace_content_operation_redirects (operation_id, source_workspace_id, source_kind, source_id, target_workspace_id, target_kind, target_id) VALUES ($1, $2, 'document', $3, $4, 'document', $3)")
    .bind(operation).bind(source).bind(key).bind(target)
    .execute(&pool).await.expect("seed source redirect");

  let cookie = format!("affine_session={session_id}");
  let sid = eio_handshake(&app, &cookie).await;
  sio_post(&app, &sid, &cookie, r#"40{"clientKind":"web"}"#.to_string()).await;
  sio_poll_until(&app, &sid, &cookie, "40").await;
  let joined = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    1,
    "space:join",
    json!({
      "spaceType": "workspace", "spaceId": source, "clientVersion": CURRENT_SYNC_CLIENT_VERSION
    }),
    "431[",
  )
  .await;
  assert!(joined.contains("success"), "join failed: {joined}");
  for (ack_id, doc_key, expected) in [(2, key, "DOC_MOVED"), (3, "unknown-key", "DOC_NOT_FOUND")] {
    let response = sio_emit_with_ack(
      &app,
      &sid,
      &cookie,
      ack_id,
      "space:load-doc",
      json!({
        "spaceType": "workspace", "spaceId": source, "docId": doc_key,
        "stateVector": STANDARD.encode([0]), "client": "web"
      }),
      &format!("43{ack_id}["),
    )
    .await;
    assert!(
      response.contains(expected),
      "wrong lifecycle classification: {response}"
    );
    assert!(response.contains(r#""retryable":false"#));
    assert!(
      !response.contains(&target.to_string()),
      "retirement must not disclose the destination"
    );
  }
  let rejected = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    4,
    "space:push-doc-update",
    json!({
      "spaceType": "workspace", "spaceId": source, "docId": key,
      "update": STANDARD.encode(text_update("retained offline changes")), "client": "storage"
    }),
    "434[",
  )
  .await;
  assert!(
    rejected.contains("DOC_MOVED"),
    "stale push was not classified as moved: {rejected}"
  );
  assert!(rejected.contains(r#""retryable":false"#));
  let recreated: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id = $1 AND external_id = $2)")
      .bind(source)
      .bind(key)
      .fetch_one(&pool)
      .await
      .expect("check source retirement");
  assert!(
    !recreated,
    "a stale cache must not recreate a moved source without a registration receipt"
  );

  let returned = helpers::create_doc(&pool, source, user_id).await;
  sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
    .bind(returned)
    .bind(key)
    .execute(&pool)
    .await
    .expect("seed legitimately returned key");
  let loaded = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    5,
    "space:load-doc",
    json!({
      "spaceType": "workspace", "spaceId": source, "docId": key,
      "stateVector": STANDARD.encode([0]), "client": "web"
    }),
    "435[",
  )
  .await;
  assert!(loaded.contains(r#""missing""#), "returned key did not load: {loaded}");
  assert!(
    !loaded.contains(r#""error""#),
    "a live returned key must shadow the historical redirect: {loaded}"
  );
  sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
    .bind(operation)
    .execute(&pool)
    .await
    .expect("clean move fixture");
  helpers::cleanup_workspaces(&pool, &[source, target]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn websocket_maps_invalid_yjs_and_preserves_store_side_effect_boundary() {
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p0_04_ingress").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let cookie = format!("affine_session={session_id}");
  let sid = eio_handshake(&app, &cookie).await;
  sio_post(&app, &sid, &cookie, r#"40{"clientKind":"web"}"#.to_string()).await;
  sio_poll_until(&app, &sid, &cookie, "40").await;
  let join = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "clientVersion": CURRENT_SYNC_CLIENT_VERSION
  });
  let joined = sio_emit_with_ack(&app, &sid, &cookie, 1, "space:join", join, "success").await;
  assert!(joined.contains("success"), "workspace join must succeed: {joined}");

  let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read initial update count");
  let base_payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "update": "not-base64"
  });
  let invalid_base64 = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    2,
    "space:push-doc-update",
    base_payload,
    "INVALID_YJS_UPDATE",
  )
  .await;
  assert!(invalid_base64.contains("INVALID_YJS_UPDATE"));

  let invalid_v1 = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "update": STANDARD.encode([0xff])
  });
  let invalid_update = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    3,
    "space:push-doc-update",
    invalid_v1,
    "INVALID_YJS_UPDATE",
  )
  .await;
  assert!(invalid_update.contains("INVALID_YJS_UPDATE"));

  let after_invalid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read rejected update count");
  assert_eq!(after_invalid, before, "rejected updates must not reach persistence");

  // Exercise the production 32 MiB decoded-byte boundary through Socket.IO,
  // including Base64 amplification. The transport limit remains higher; the
  // application ingress limit is the contract under test.
  const MAX_UPDATE_BYTES: usize = 32 * 1024 * 1024;
  let oversized_v1 = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "update": STANDARD.encode(vec![0u8; MAX_UPDATE_BYTES + 1])
  });
  let oversized = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    4,
    "space:push-doc-update",
    oversized_v1,
    "UPDATE_TOO_LARGE",
  )
  .await;
  assert!(oversized.contains("UPDATE_TOO_LARGE"));

  let after_oversized: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read oversized update count");
  assert_eq!(after_oversized, before, "oversized updates must not reach persistence");

  let valid = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "update": STANDARD.encode(text_update("valid ingress"))
  });
  let accepted = sio_emit_with_ack(&app, &sid, &cookie, 5, "space:push-doc-update", valid, "accepted").await;
  assert!(
    accepted.contains("accepted"),
    "valid Yjs v1 must be accepted: {accepted}"
  );

  let after_valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read accepted update count");
  assert_eq!(after_valid, before + 1, "only the valid update may be persisted");

  let invalid_state_vector = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "stateVector": "not-base64",
    "client": "web"
  });
  let rejected_load = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    6,
    "space:load-doc",
    invalid_state_vector,
    "INVALID_STATE_VECTOR",
  )
  .await;
  assert!(rejected_load.contains("INVALID_STATE_VECTOR"));
  assert!(rejected_load.contains(r#""retryable":false"#));
  assert!(
    !rejected_load.contains(r#""missing""#),
    "invalid state must not receive a full-document fallback: {rejected_load}"
  );

  let valid_load = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": doc_id.to_string(),
    "stateVector": STANDARD.encode([0]),
    "client": "web"
  });
  let loaded = sio_emit_with_ack(&app, &sid, &cookie, 7, "space:load-doc", valid_load, "missing").await;
  assert!(
    loaded.contains(r#""missing""#),
    "load ACK must carry the Yjs diff: {loaded}"
  );
  assert!(
    loaded.contains(r#""state""#),
    "load ACK must carry the server state vector: {loaded}"
  );
  assert!(
    !loaded.contains(r#""error""#),
    "valid load must not fall back to an error: {loaded}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[sqlx::test(migrations = false)]
async fn websocket_1000_exact_replays_persist_and_broadcast_once(pool: sqlx::PgPool) {
  // The production consumer claims globally, in bounded batches. Keep the
  // deliberate older orphan in this fixture without consuming another test's
  // backlog or depending on the shared database having fewer than 50 events.
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("owned outbox database migrations");
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle_and_pool(pool).await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p05_replay_guard").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;
  let stale_event_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO outbox_events (
       id, aggregate_type, aggregate_id, event_type, payload, created_at
     ) VALUES ($1, 'document', $2, 'workspace_doc_broadcast', $3, '1970-01-01T00:00:00Z')",
  )
  .bind(stale_event_id)
  .bind(Uuid::new_v4().to_string())
  .bind(json!({
    "workspaceId": workspace_id,
    "docId": Uuid::new_v4(),
    "sequence": 1,
    "actorUserId": user_id
  }))
  .execute(&pool)
  .await
  .expect("seed an older orphan broadcast that must not poison the consumer");
  let cookie = format!("affine_session={session_id}");
  let sender_sid = eio_handshake(&app, &cookie).await;
  let receiver_sid = eio_handshake(&app, &cookie).await;

  for sid in [&sender_sid, &receiver_sid] {
    sio_post(&app, sid, &cookie, "40".to_string()).await;
    sio_poll_until(&app, sid, &cookie, "40").await;
    let joined = sio_emit_with_ack(
      &app,
      sid,
      &cookie,
      1,
      "space:join",
      json!({
        "spaceType": "workspace",
        "spaceId": workspace_id.to_string(),
        "clientVersion": CURRENT_SYNC_CLIENT_VERSION
      }),
      "success",
    )
    .await;
    assert!(joined.contains("success"), "workspace join must succeed: {joined}");
  }

  let (insert, delete, known_state) = insert_delete_updates("one durable edit");
  let encoded_update = STANDARD.encode(insert);
  let (replays_done_tx, mut replays_done_rx) = tokio::sync::oneshot::channel();
  let push_replays = async {
    for batch_index in 0..10_u64 {
      // Engine.IO polling accepts record-separated packets in one POST.
      // Batching retains all 1,000 Socket.IO events without measuring 1,000
      // unrelated HTTP round trips.
      let packets = (0..100_u64)
        .map(|offset| {
          let ack_id = batch_index * 100 + offset + 2;
          format!(
            "42{ack_id}{}",
            json!([
              "space:push-doc-update",
              {
                "spaceType": "workspace",
                "spaceId": workspace_id.to_string(),
                "docId": doc_id.to_string(),
                "update": encoded_update.clone()
              }
            ])
          )
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");
      let first_ack_id = batch_index * 100 + 2;
      let last_ack_id = first_ack_id + 99;
      tokio::join!(
        sio_post(&app, &sender_sid, &cookie, packets),
        sio_collect_ack_range(&app, &sender_sid, &cookie, first_ack_id, last_ack_id)
      );
    }
    let _ = replays_done_tx.send(());
  };
  let receive_during_replays = async {
    let mut packets = String::new();
    let mut replays_done = false;
    let mut broadcast_deadline = None;
    loop {
      if replays_done && packets.contains("space:broadcast-doc-updates") {
        break;
      }
      let wait = broadcast_deadline
        .map(|deadline: Instant| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(Duration::from_secs(5));
      assert!(
        !wait.is_zero(),
        "durable workspace broadcast did not arrive after replay persistence"
      );
      tokio::select! {
        biased;
        packet = sio_poll_bounded(&app, &receiver_sid, &cookie, wait.min(Duration::from_secs(5))) => {
          let Some(packet) = packet else {
            continue;
          };
          if packet == "2" || packet.contains(":2") || packet.starts_with("1:2") {
            sio_post(&app, &receiver_sid, &cookie, "3".to_string()).await;
          }
          packets.push_str(&packet);
        }
        _ = &mut replays_done_rx, if !replays_done => {
          replays_done = true;
          broadcast_deadline = Some(Instant::now() + Duration::from_secs(10));
        },
      }
    }
    packets
  };
  let (_, broadcast) = tokio::join!(push_replays, receive_during_replays);
  assert_eq!(
    broadcast.matches("space:broadcast-doc-updates").count(),
    1,
    "the receiver must observe exactly one batched-protocol broadcast: {broadcast}"
  );
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count replay-guarded updates");
  assert_eq!(update_count, 1, "1,000 exact pushes must create one update row");

  let delete_ack = sio_emit_with_ack(
    &app,
    &sender_sid,
    &cookie,
    1_002,
    "space:push-doc-update",
    json!({
      "spaceType": "workspace",
      "spaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "update": STANDARD.encode(delete)
    }),
    "accepted",
  )
  .await;
  assert!(delete_ack.contains("accepted"));
  let delete_broadcast = sio_poll_until(&app, &receiver_sid, &cookie, "space:broadcast-doc-updates").await;
  assert_eq!(delete_broadcast.matches("space:broadcast-doc-updates").count(), 1);

  let noop_ack = sio_emit_with_ack(
    &app,
    &sender_sid,
    &cookie,
    1_003,
    "space:push-doc-update",
    json!({
      "spaceType": "workspace",
      "spaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "update": STANDARD.encode(known_state)
    }),
    "accepted",
  )
  .await;
  assert!(noop_ack.contains("accepted"));
  let after_noop = sio_poll_bounded(&app, &receiver_sid, &cookie, Duration::from_millis(200)).await;
  assert!(
    after_noop
      .as_deref()
      .is_none_or(|packet| !packet.contains("space:broadcast-doc-updates")),
    "a CRDT no-op must not create a foreign-client broadcast: {after_noop:?}"
  );
  let after_noop_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count updates after semantic no-op");
  assert_eq!(
    after_noop_count, 2,
    "the effective delete persists, its re-encoding does not"
  );

  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(stale_event_id)
    .execute(&pool)
    .await
    .expect("delete stale broadcast fixture");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn websocket_first_push_without_provenance_is_server_observed() {
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "p03_first_push").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();
  let cookie = format!("affine_session={session_id}");
  let sid = eio_handshake(&app, &cookie).await;
  sio_post(&app, &sid, &cookie, r#"40{"clientKind":"web"}"#.to_string()).await;
  sio_poll_until(&app, &sid, &cookie, "40").await;
  let joined = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    1,
    "space:join",
    json!({
      "spaceType": "workspace",
      "spaceId": workspace_id.to_string(),
      "clientVersion": CURRENT_SYNC_CLIENT_VERSION
    }),
    "success",
  )
  .await;
  assert!(joined.contains("success"), "workspace join must succeed: {joined}");

  let accepted = sio_emit_with_ack(
    &app,
    &sid,
    &cookie,
    2,
    "space:push-doc-update",
    json!({
      "spaceType": "workspace",
      "spaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "update": STANDARD.encode([0, 0]),
      "client": "storage",
      "clientFormat": "myoxus-native",
      "clientCapabilities": "document-metadata,sync"
    }),
    "accepted",
  )
  .await;
  assert!(
    accepted.contains("accepted"),
    "normal first push must materialize the document: {accepted}"
  );

  let persisted_doc_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
    .bind(workspace_id)
    .bind(doc_id.to_string())
    .fetch_one(&pool)
    .await
    .expect("created document identity");
  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(persisted_doc_id)
    .fetch_one(&pool)
    .await
    .expect("created update count");
  let (mode, decision, idempotency_key, raw_provenance, audit_client_instance, normalized): (
    String,
    String,
    String,
    Value,
    Option<String>,
    Value,
  ) = sqlx::query_as(
    "SELECT provenance_mode, decision_code, idempotency_key, raw_provenance, client_instance_id, normalized_provenance \
       FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(persisted_doc_id)
  .fetch_one(&pool)
  .await
  .expect("first-sync audit");

  assert_eq!(update_count, 1);
  assert_eq!(mode, "server_observed_first_sync");
  assert_eq!(decision, "server_observed_first_sync");
  assert_eq!(
    idempotency_key,
    format!("server-first-sync:{workspace_id}:{persisted_doc_id}")
  );
  assert_eq!(raw_provenance, Value::Null);
  assert_eq!(audit_client_instance, None);
  assert_eq!(normalized["connectionClientKind"], "web");
  assert!(normalized.get("connectionClientInstanceHash").is_none());

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}
