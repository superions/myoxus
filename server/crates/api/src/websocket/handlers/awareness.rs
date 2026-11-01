/// Handlers for awareness events: `space:update-awareness`, `space:join-awareness`,
/// `space:leave-awareness`, and `space:load-awarenesses`.
use std::sync::Arc;

use serde_json::json;
use socketioxide::extract::{AckSender, SocketRef};
use tracing::debug;

use crate::state::ApiState;

use super::super::access::{await_authenticated, ensure_space_joined};
use super::super::error::emit_sync_error;
use super::super::room::{get_room, is_supported_ws_client_version};
use super::super::state::{
  forget_awareness_membership, has_awareness_membership, make_awareness_key, remember_awareness_membership,
};
use super::super::types::{AwarenessPayload, JoinAwarenessPayload, UpdateAwarenessPayload};

/// Handle `space:update-awareness` (fire-and-forget, no ACK).
///
/// Broadcasts ephemeral state locally (excluding the sender) and through Redis.
/// A missed publication is recovered by client collection after reconnect.
pub(in crate::websocket) async fn handle_update_awareness(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: UpdateAwarenessPayload,
) {
  if data.space_id.trim().is_empty()
    || data.doc_id.trim().is_empty()
    || data.awareness_update.as_deref().unwrap_or_default().is_empty()
  {
    emit_sync_error(
      &socket,
      "SpaceAccessDenied",
      "invalid awareness payload",
      Some(&data.space_id),
    );
    return;
  }
  let space_id = data.space_id.as_str();
  let doc_id = data.doc_id.as_str();
  let space_type = data.space_type;
  let awareness_key = make_awareness_key(space_type, space_id, doc_id);
  if !has_awareness_membership(&socket.id.to_string(), &awareness_key) {
    emit_sync_error(
      &socket,
      "NotInSpace",
      "socket has not joined awareness room",
      Some(space_id),
    );
    return;
  }
  let room = get_room(space_type, space_id, &format!("{}:awareness", doc_id));
  let sender_sid = socket.id.to_string();
  let payload = json!({
      "spaceType": space_type,
      "spaceId": data.space_id,
      "docId": data.doc_id,
      "awarenessUpdate": data.awareness_update.unwrap_or_default()
  });
  let io_ref = state.socket_io.read().unwrap_or_else(|e| e.into_inner()).clone();
  if let Some(io) = &io_ref {
    let _ = io
      .to(room)
      .except(sender_sid.clone())
      .emit("space:broadcast-awareness-update", &payload)
      .await;
  }
  if let Some(adapter) = state.redis_ws_adapter() {
    adapter
      .broadcast_to_workspace(
        &data.space_id,
        "space:broadcast-awareness-update",
        &payload,
        &sender_sid,
      )
      .await;
  }
}

/// Handle `space:join-awareness` (ACK-based).
///
/// Validates `clientVersion`, `spaceId`, and `docId`, ensures the socket
/// has already joined the space, then joins the per-doc awareness room and
/// records membership.
pub(in crate::websocket) async fn handle_join_awareness(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: JoinAwarenessPayload,
  ack: AckSender,
) {
  let socket_id = socket.id.to_string();
  let user_id = match await_authenticated(&socket_id).await {
    Some(id) => id,
    None => {
      ack
        .send(&json!({ "error": { "name": "UNAUTHORIZED", "message": "not authenticated" } }))
        .ok();
      return;
    }
  };
  if !is_supported_ws_client_version(&data.client_version) {
    emit_sync_error(
      &socket,
      "SpaceAccessDenied",
      "unsupported client version",
      Some(&data.space_id),
    );
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    let _ = socket.clone().disconnect();
    return;
  }
  if data.space_id.trim().is_empty() || data.doc_id.trim().is_empty() {
    emit_sync_error(
      &socket,
      "SpaceAccessDenied",
      "spaceId and docId are required",
      Some(&data.space_id),
    );
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    let _ = socket.clone().disconnect();
    return;
  }
  if let Err(e) = ensure_space_joined(&state, &socket, user_id, data.space_type, &data.space_id).await {
    debug!(%user_id, space_id = %data.space_id, error = %e, "join awareness denied");
    emit_sync_error(&socket, "SpaceAccessDenied", &e, Some(&data.space_id));
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    return;
  }
  let room = get_room(data.space_type, &data.space_id, &format!("{}:awareness", data.doc_id));
  tracing::debug!(
    user_id = %user_id,
    space_id = %data.space_id,
    doc_id = %data.doc_id,
    client = ?data.client,
    client_format = ?data.client_format,
    client_capabilities = ?data.client_capabilities,
    "websocket: joined awareness room"
  );
  socket.join(room);
  remember_awareness_membership(
    &socket_id,
    make_awareness_key(data.space_type, &data.space_id, &data.doc_id),
  );
  ack
    .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": true } }))
    .ok();
}

/// Handle `space:leave-awareness` (fire-and-forget, no ACK).
///
/// Leaves the per-doc awareness room and removes the membership record.
pub(in crate::websocket) async fn handle_leave_awareness(socket: SocketRef, data: AwarenessPayload) {
  if data.space_id.trim().is_empty() || data.doc_id.trim().is_empty() {
    emit_sync_error(
      &socket,
      "SpaceAccessDenied",
      "spaceId and docId are required",
      Some(&data.space_id),
    );
    return;
  }
  let room = get_room(data.space_type, &data.space_id, &format!("{}:awareness", data.doc_id));
  socket.leave(room);
  forget_awareness_membership(
    &socket.id.to_string(),
    &make_awareness_key(data.space_type, &data.space_id, &data.doc_id),
  );
}

/// Handle `space:load-awarenesses` (fire-and-forget, no ACK).
///
/// Broadcasts a `space:collect-awareness` event to all sockets in the awareness
/// room (excluding the sender), prompting them to re-broadcast their current
/// awareness state, including peers connected to other API nodes.
pub(in crate::websocket) async fn handle_load_awarenesses(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: AwarenessPayload,
) {
  if data.space_id.trim().is_empty() || data.doc_id.trim().is_empty() {
    emit_sync_error(
      &socket,
      "SpaceAccessDenied",
      "spaceId and docId are required",
      Some(&data.space_id),
    );
    return;
  }
  let awareness_key = make_awareness_key(data.space_type, &data.space_id, &data.doc_id);
  if !has_awareness_membership(&socket.id.to_string(), &awareness_key) {
    emit_sync_error(
      &socket,
      "NotInSpace",
      "socket has not joined awareness room",
      Some(&data.space_id),
    );
    return;
  }
  let room = get_room(data.space_type, &data.space_id, &format!("{}:awareness", data.doc_id));
  let sender_sid = socket.id.to_string();
  let payload = json!({
      "spaceType": data.space_type,
      "spaceId": data.space_id,
      "docId": data.doc_id
  });
  let io_ref = state.socket_io.read().unwrap_or_else(|e| e.into_inner()).clone();
  if let Some(io) = &io_ref {
    let _ = io
      .to(room)
      .except(sender_sid.clone())
      .emit("space:collect-awareness", &payload)
      .await;
  }
  if let Some(adapter) = state.redis_ws_adapter() {
    adapter
      .broadcast_to_workspace(&data.space_id, "space:collect-awareness", &payload, &sender_sid)
      .await;
  }
}
