/// Handlers for notification events: `notification:subscribe` and `notification:ack`.
use std::sync::Arc;

use serde_json::json;
use socketioxide::extract::SocketRef;
use tracing::{debug, info};

use crate::state::ApiState;

use super::super::access::await_authenticated;
use super::super::state::{NOTIFICATION_EVENT_ACKS, ack_notification_delivery, mark_notification_subscribed};
use super::super::types::NotificationAckPayload;

/// Handle `notification:subscribe`.
///
/// Marks the socket as subscribed to notification push events, then
/// fetches and returns the current unread notification count.
pub(in crate::websocket) async fn handle_notification_subscribe(state: Arc<ApiState>, socket: SocketRef) {
  let socket_id = socket.id.to_string();
  mark_notification_subscribed(&socket_id);
  let current_user_id = match await_authenticated(&socket_id).await {
    Some(id) => id,
    None => return,
  };
  let unread_count = state.notification().unread_count(current_user_id).await.unwrap_or(0);
  info!(sid = %socket_id, user_id = %current_user_id, unread_count, "notification stream subscribed");
  let _ = socket.emit(
    "notification:subscribe",
    &json!({"data": {"success": true, "unreadCount": unread_count}}),
  );
}

/// Handle `notification:ack`.
///
/// Records a delivery acknowledgement for the given `event_id`. If this socket
/// was the first to ack, mirrors the ack to Redis for cross-instance deduplication
/// (SC-M-01).
pub(in crate::websocket) async fn handle_notification_ack(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: NotificationAckPayload,
) {
  if data.event_id.trim().is_empty() {
    let _ = socket.emit("notification:ack", &json!({"data": {"success": false}}));
    return;
  }
  let socket_id = socket.id.to_string();
  let success = ack_notification_delivery(&socket_id, &data.event_id);
  // SC-M-01: Mirror notification ack to Redis for cross-instance deduplication.
  if success && let Some(adapter) = state.redis_ws_adapter() {
    adapter.ack_notification(&data.event_id).await;
  }
  let acked_by = NOTIFICATION_EVENT_ACKS
    .get(&data.event_id)
    .map(|entry| entry.value().0.len())
    .unwrap_or(0);
  debug!(sid = %socket_id, event_id = %data.event_id, success, acked_by, "notification ack processed");
  let _ = socket.emit(
    "notification:ack",
    &json!({"data": {"success": success, "eventId": data.event_id}}),
  );
}
