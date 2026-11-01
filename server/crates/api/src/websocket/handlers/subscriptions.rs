/// Per-socket subscription setup — notification and Copilot fanout loops.
///
/// Called once per connection from `on_connect`. Spawns two long-running
/// `tokio::spawn` loops that forward broadcast messages to the socket:
/// - `run_notification_fanout_loop` — forwards `notification:push` events
/// - `run_copilot_fanout_loop` — forwards `copilot:event` envelopes
use std::sync::Arc;

use serde_json::json;
use socketioxide::extract::SocketRef;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::state::ApiState;

use super::super::fanout::{copilot_ui_fanout_tx, database_fanout_tx, notification_fanout_tx};
use super::super::state::{
  SOCKET_USER_MAP, is_copilot_subscribed, is_notification_subscribed, record_notification_delivery,
};
use super::super::types::{
  CopilotUiEventEnvelope, CopilotUiFanoutMessage, DatabaseChangeFanoutMessage, NotificationFanoutMessage,
  NotificationPushEnvelope,
};

/// Spawn per-socket notification and Copilot fanout loops.
///
/// Not async — spawns two background tasks and returns immediately.
/// Auth is already guaranteed by the time this is called (`auth_middleware`).
pub(in crate::websocket) fn spawn_socket_subscriptions(socket: SocketRef, _state: Arc<ApiState>) {
  let auth_socket = socket.clone();
  tokio::spawn(async move {
    let user_id = match SOCKET_USER_MAP.get(&auth_socket.id.to_string()).map(|v| *v) {
      Some(id) => id,
      None => {
        // Should never happen — middleware guarantees auth before on_connect
        warn!(sid = %auth_socket.id, "on_connect: user not in SOCKET_USER_MAP (middleware bug?)");
        let _ = auth_socket.disconnect();
        return;
      }
    };
    SOCKET_USER_MAP.insert(auth_socket.id.to_string(), user_id);
    info!(user_id = %user_id, sid = %auth_socket.id, "websocket: client connected");

    // Start notification fanout loop
    let fanout_socket = auth_socket.clone();
    let fanout_socket_id = auth_socket.id.to_string();
    let fanout_rx = notification_fanout_tx().subscribe();
    tokio::spawn(run_notification_fanout_loop(
      fanout_socket,
      fanout_socket_id,
      user_id,
      fanout_rx,
    ));

    // Start copilot fanout loop
    let copilot_socket = auth_socket.clone();
    let copilot_socket_id = auth_socket.id.to_string();
    let copilot_rx = copilot_ui_fanout_tx().subscribe();
    tokio::spawn(run_copilot_fanout_loop(
      copilot_socket,
      copilot_socket_id,
      user_id,
      copilot_rx,
    ));

    if let Some(tx) = database_fanout_tx() {
      let database_socket = auth_socket.clone();
      let database_socket_id = auth_socket.id.to_string();
      tokio::spawn(run_database_fanout_loop(
        database_socket,
        database_socket_id,
        tx.subscribe(),
      ));
    }
  });
}

async fn run_database_fanout_loop(
  socket: SocketRef,
  socket_id: String,
  mut rx: broadcast::Receiver<DatabaseChangeFanoutMessage>,
) {
  loop {
    match rx.recv().await {
      Ok(message) => {
        let joined = if message.workspace_hint {
          super::super::state::has_space_membership(
            &socket_id,
            &super::super::state::make_space_key(
              super::super::types::SpaceType::Workspace,
              &message.workspace_id.to_string(),
            ),
          )
        } else {
          super::super::state::DATABASE_PRESENCE
            .get(&socket_id)
            .is_some_and(|memberships| memberships.contains_key(&(message.workspace_id, message.database_id)))
        };
        if !joined {
          continue;
        }
        let event = if message.workspace_hint {
          "database:tasks-changed"
        } else {
          "database:change"
        };
        if let Err(error) = socket.emit(event, &message.payload) {
          debug!(sid = %socket_id, error = %error, "socket closed while pushing database change");
          break;
        }
      }
      Err(broadcast::error::RecvError::Closed) => break,
      Err(broadcast::error::RecvError::Lagged(skipped)) => {
        warn!(sid = %socket_id, skipped, "database change fanout lag detected");
      }
    }
  }
}

async fn run_notification_fanout_loop(
  socket: SocketRef,
  socket_id: String,
  user_id: Uuid,
  mut rx: broadcast::Receiver<NotificationFanoutMessage>,
) {
  loop {
    match rx.recv().await {
      Ok(message) => {
        if message.user_id != user_id {
          continue;
        }
        if !is_notification_subscribed(&socket_id) {
          continue;
        }
        let envelope = NotificationPushEnvelope {
          event_id: message.event_id.clone(),
          event_type: message.event_type,
          payload: message.payload,
        };
        record_notification_delivery(&socket_id, &message.event_id);
        if let Err(error) = socket.emit("notification:push", &envelope) {
          debug!(sid = %socket_id, %user_id, error = %error, "socket closed while pushing notification");
          break;
        }
      }
      Err(broadcast::error::RecvError::Closed) => break,
      Err(broadcast::error::RecvError::Lagged(skipped)) => {
        warn!(sid = %socket_id, %user_id, skipped, "notification fanout lag detected for socket");
      }
    }
  }
}

async fn run_copilot_fanout_loop(
  socket: SocketRef,
  socket_id: String,
  user_id: Uuid,
  mut rx: broadcast::Receiver<CopilotUiFanoutMessage>,
) {
  loop {
    match rx.recv().await {
      Ok(message) => {
        if message.user_id != user_id {
          continue;
        }
        if !is_copilot_subscribed(&socket_id) {
          continue;
        }
        let envelope = CopilotUiEventEnvelope {
          event_id: message.event_id,
          event_type: message.event_type,
          session_id: message.session_id,
          payload: message.payload,
        };
        if let Err(error) = socket.emit("copilot:event", &json!({ "data": envelope })) {
          warn!(sid = %socket_id, error = %error, "failed to emit copilot event");
        }
      }
      Err(broadcast::error::RecvError::Closed) => break,
      Err(broadcast::error::RecvError::Lagged(skipped)) => {
        warn!(sid = %socket_id, %user_id, skipped, "copilot event fanout lag detected");
      }
    }
  }
}
