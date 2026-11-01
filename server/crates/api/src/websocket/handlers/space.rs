/// Handlers for `space:join` and `space:leave` events.
use std::sync::Arc;

use serde_json::json;
use socketioxide::extract::{AckSender, SocketRef};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::state::ApiState;

use super::super::access::{assert_accessible, await_authenticated};
use super::super::error::emit_sync_error;
use super::super::room::{get_protocol_rooms, get_room, is_supported_ws_client_version};
use super::super::state::{
  SOCKET_CLIENT_VERSIONS, WORKSPACE_SESSIONS, forget_space_membership, make_space_key, remember_space_membership,
};
use super::super::types::{JoinSpacePayload, LeaveSpacePayload, SpaceType};

/// Handle `space:join` (ACK-based).
///
/// Authenticates the user, validates `clientVersion` and `spaceId`, checks
/// access permissions, then joins the appropriate socketioxide rooms and
/// records membership in `WORKSPACE_SESSIONS` + optional Redis (SC-M-01).
///
/// Responds with `{ data: { clientId: "<sid>", success: bool } }`.
pub(in crate::websocket) async fn handle_space_join(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: JoinSpacePayload,
  ack: AckSender,
) {
  let user_id = match await_authenticated(&socket.id.to_string()).await {
    Some(id) => id,
    None => {
      ack
        .send(&json!({ "error": { "name": "UNAUTHORIZED", "message": "not authenticated" } }))
        .ok();
      return;
    }
  };
  if !is_supported_ws_client_version(&data.client_version) {
    warn!(%user_id, version = %data.client_version, "unsupported client version for space join");
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    let _ = socket.clone().disconnect();
    return;
  }
  if data.space_id.trim().is_empty() {
    emit_sync_error(&socket, "SpaceAccessDenied", "spaceId is required", None);
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    let _ = socket.clone().disconnect();
    return;
  }
  if let Err(e) = assert_accessible(&state, user_id, data.space_type, &data.space_id, None, None).await {
    debug!(%user_id, space_id = %data.space_id, error = %e, "join space denied");
    emit_sync_error(&socket, "SpaceAccessDenied", &e, Some(&data.space_id));
    ack
      .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": false } }))
      .ok();
    return;
  }

  // SC-H-04: Record the client version so auto-join (ensure_space_joined)
  // can use the correct protocol version for this socket.
  SOCKET_CLIENT_VERSIONS.insert(socket.id.to_string(), data.client_version.clone());

  let (target_room, other_room) = get_protocol_rooms(data.space_type, &data.space_id, &data.client_version);
  socket.leave(other_room);
  socket.join(target_room.clone());
  socket.join(get_room(data.space_type, &data.space_id, "sync"));
  remember_space_membership(&socket.id.to_string(), make_space_key(data.space_type, &data.space_id));
  tracing::debug!(
    user_id = %user_id,
    room = %target_room,
    client = ?data.client,
    client_format = ?data.client_format,
    client_capabilities = ?data.client_capabilities,
    "websocket: joined room"
  );

  if data.space_type == SpaceType::Workspace
    && let Ok(ws_id) = Uuid::parse_str(&data.space_id)
  {
    WORKSPACE_SESSIONS
      .entry(ws_id)
      .or_default()
      .insert(socket.id.to_string());
    // SC-M-01: Mirror workspace join to Redis for cross-instance visibility.
    if let Some(adapter) = state.redis_ws_adapter() {
      if let Err(error) = adapter
        .join_workspace(
          ws_id,
          &socket.id.to_string(),
          user_id,
          state.config.websocket.ping_interval_seconds,
        )
        .await
      {
        warn!(%ws_id, %error, "workspace membership registration unavailable; analytics will retry");
      }
    }
  }

  info!(
    %user_id,
    space_id = %data.space_id,
    version = %data.client_version,
    client = ?data.client,
    client_format = ?data.client_format,
    "user joined space"
  );
  state.metrics().record(
    myoxus_application::metrics::MetricsCategory::Collab,
    "session_started",
    &[(
      "space_type",
      match data.space_type {
        SpaceType::Workspace => "workspace",
        SpaceType::Userspace => "userspace",
      },
    )],
  );
  ack
    .send(&json!({ "data": { "clientId": socket.id.to_string(), "success": true } }))
    .ok();
}

/// Handle `space:leave` (fire-and-forget, no ACK).
///
/// Leaves all room variants for the given space, clears membership tracking,
/// and mirrors the leave to Redis (SC-M-01) for workspace-type spaces.
pub(in crate::websocket) async fn handle_space_leave(state: Arc<ApiState>, socket: SocketRef, data: LeaveSpacePayload) {
  socket.leave(get_room(data.space_type, &data.space_id, "sync"));
  socket.leave(get_room(data.space_type, &data.space_id, "sync-025"));
  socket.leave(get_room(data.space_type, &data.space_id, "sync-026"));
  forget_space_membership(&socket.id.to_string(), &make_space_key(data.space_type, &data.space_id));

  if data.space_type == SpaceType::Workspace
    && let Ok(ws_id) = Uuid::parse_str(&data.space_id)
  {
    if let Some(mut entry) = WORKSPACE_SESSIONS.get_mut(&ws_id) {
      entry.value_mut().remove(&socket.id.to_string());
    }
    // SC-M-01: Mirror workspace leave to Redis.
    if let Some(adapter) = state.redis_ws_adapter() {
      adapter.leave_workspace(ws_id, &socket.id.to_string()).await;
    }
  }
  info!(sid = %socket.id, space_id = %data.space_id, space_type = %data.space_type, "user left space");
}
