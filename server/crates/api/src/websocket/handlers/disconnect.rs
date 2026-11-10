/// Socket disconnect handler — cleans up all per-socket state.
///
/// Called by socketioxide when a client disconnects for any reason.
/// Removes the socket from all local DashMaps and optionally from
/// Redis session tracking (cross-instance coordination).
use std::sync::Arc;

use socketioxide::socket::DisconnectReason;
use tracing::info;
use uuid::Uuid;

use crate::state::ApiState;
use crate::websocket::redis_adapter::RedisWsAdapter;

use super::super::circuit_breaker;
use super::super::state::{
  SOCKET_AWARENESS_MEMBERSHIPS, SOCKET_CLIENT_CONTEXTS, SOCKET_CLIENT_VERSIONS, SOCKET_COPILOT_SUBSCRIPTIONS,
  SOCKET_NOTIFICATION_SUBSCRIPTIONS, SOCKET_PENDING_NOTIFICATION_ACKS, SOCKET_SESSION_MAP, SOCKET_SPACE_MEMBERSHIPS,
  SOCKET_USER_MAP, WORKSPACE_SESSIONS,
};

/// Register the `on_disconnect` handler for this socket.
///
/// Captures the socket ID and optional Redis adapter so that cleanup
/// can proceed without holding a `SocketRef` after disconnection.
pub(in crate::websocket) fn register(socket: &socketioxide::extract::SocketRef, state: Arc<ApiState>) {
  let sid_for_cleanup = socket.id.to_string();
  let disconnect_adapter = state.redis_ws_adapter().cloned();
  let socket_io = state.socket_io.clone();
  socket.on_disconnect(move |reason: DisconnectReason| async move {
    let io = socket_io.read().unwrap_or_else(|error| error.into_inner()).clone();
    handle_disconnect(sid_for_cleanup, reason, disconnect_adapter.clone(), io);
  });
}

/// Perform all per-socket cleanup after a disconnect.
///
/// Removes the socket from:
/// - `SOCKET_USER_MAP` (user identity)
/// - `SOCKET_SESSION_MAP` (authoritative session ownership)
/// - `SOCKET_CLIENT_CONTEXTS` (ephemeral server-derived client class)
/// - `SOCKET_SPACE_MEMBERSHIPS` / `WORKSPACE_SESSIONS` (room memberships)
/// - `SOCKET_AWARENESS_MEMBERSHIPS` (awareness rooms)
/// - `SOCKET_NOTIFICATION_SUBSCRIPTIONS` / `SOCKET_COPILOT_SUBSCRIPTIONS` (fanout flags)
/// - `SOCKET_PENDING_NOTIFICATION_ACKS` (unconfirmed ack tracking)
/// - `SOCKET_CLIENT_VERSIONS` (protocol version negotiation)
/// - circuit-breaker state (P101-WS-ERR-03)
///
/// Asynchronously removes the socket from Redis workspace session maps
/// (SC-M-01) via `RedisWsAdapter::leave_all_workspaces`.
fn handle_disconnect(
  socket_id: String,
  reason: DisconnectReason,
  adapter: Option<Arc<RedisWsAdapter>>,
  io: Option<socketioxide::SocketIo>,
) {
  info!(sid = %socket_id, %reason, "websocket: disconnect reason");

  // Collect workspace IDs this socket was in (for Redis cleanup).
  let workspace_ids: Vec<Uuid> = WORKSPACE_SESSIONS
    .iter()
    .filter(|entry| entry.value().contains(&socket_id))
    .map(|entry| *entry.key())
    .collect();

  // Local DashMap cleanup (always).
  let disconnected_user_id = SOCKET_USER_MAP.remove(&socket_id).map(|(_, uid)| uid);
  if let Some(uid) = disconnected_user_id {
    let ws_ids: Vec<String> = workspace_ids.iter().map(|id| id.to_string()).collect();
    info!(
      user_id = %uid,
      workspaces = ?ws_ids,
      sid = %socket_id,
      "websocket: client disconnected"
    );
  }
  SOCKET_SPACE_MEMBERSHIPS.remove(&socket_id);
  SOCKET_AWARENESS_MEMBERSHIPS.remove(&socket_id);
  SOCKET_NOTIFICATION_SUBSCRIPTIONS.remove(&socket_id);
  SOCKET_COPILOT_SUBSCRIPTIONS.remove(&socket_id);
  SOCKET_PENDING_NOTIFICATION_ACKS.remove(&socket_id);
  SOCKET_CLIENT_VERSIONS.remove(&socket_id);
  SOCKET_CLIENT_CONTEXTS.remove(&socket_id);
  SOCKET_SESSION_MAP.remove(&socket_id);
  super::super::state::cancel_socket_doc_loads(
    &socket_id,
    myoxus_application::doc::DocLoadCancellationReason::Disconnect,
  );
  let database_presence = super::super::state::forget_database_presence(&socket_id);
  // P101-WS-ERR-03: Clean up circuit breaker state for this socket.
  circuit_breaker::cleanup_socket(&socket_id);
  for mut entry in WORKSPACE_SESSIONS.iter_mut() {
    entry.value_mut().remove(&socket_id);
  }

  // SC-M-01: Async Redis cleanup for cross-instance workspace sessions.
  if adapter.is_some() || io.is_some() {
    tokio::spawn(async move {
      if let Some(adapter) = &adapter {
        adapter.leave_all_workspaces(&socket_id, &workspace_ids).await;
      }
      for presence in database_presence {
        let payload = serde_json::json!({
          "workspaceId": presence.workspace_id,
          "databaseId": presence.database_id,
          "socketId": socket_id,
          "left": true,
        });
        if let Some(io) = &io {
          let _ = io
            .to(format!("database:{}", presence.database_id))
            .emit("database:presence-update", &payload)
            .await;
        }
        if let Some(adapter) = &adapter {
          adapter
            .remove_database_presence(presence.workspace_id, presence.database_id, &socket_id)
            .await;
          adapter
            .broadcast_to_workspace(
              &presence.workspace_id.to_string(),
              "database:presence-update",
              &payload,
              &socket_id,
            )
            .await;
        }
      }
    });
  }
}

#[cfg(test)]
mod tests {
  use myoxus_application::doc::DocSyncClientKind;

  use super::*;
  use crate::websocket::state::SocketClientContext;

  #[test]
  fn disconnect_removes_ephemeral_client_context() {
    let socket_id = format!("client-context-cleanup-{}", Uuid::new_v4());
    SOCKET_CLIENT_CONTEXTS.insert(
      socket_id.clone(),
      SocketClientContext {
        kind: DocSyncClientKind::Web,
      },
    );

    handle_disconnect(socket_id.clone(), DisconnectReason::TransportClose, None, None);

    assert!(
      !SOCKET_CLIENT_CONTEXTS.contains_key(&socket_id),
      "disconnect must not retain client context beyond the socket lifetime"
    );
  }
}
