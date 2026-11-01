/// Handler for `copilot:subscribe` events.
///
/// Fire-and-forget: no ACK. Marks the socket as opted into Copilot push
/// events so the fanout loop in `subscriptions.rs` starts forwarding them.
use serde_json::json;
use socketioxide::extract::SocketRef;
use tracing::debug;

use super::super::state::mark_copilot_subscribed;

/// Handle `copilot:subscribe`.
///
/// Sets the per-socket subscription flag and responds with
/// `{ data: { success: true, clientId: "<sid>" } }`.
pub(in crate::websocket) async fn handle_copilot_subscribe(socket: SocketRef) {
  let socket_id = socket.id.to_string();
  mark_copilot_subscribed(&socket_id);
  debug!(sid = %socket_id, "copilot stream subscribed");
  let _ = socket.emit(
    "copilot:subscribe",
    &json!({"data": {"success": true, "clientId": socket_id}}),
  );
}
