//! Notification and Copilot UI fan-out channels.
//!
//! Global `tokio::broadcast` channels deliver events from GraphQL mutations
//! and background jobs to connected WebSocket sockets that subscribed to the
//! respective stream. Per-socket subscription state lives in `super::state`.
//!
//! Public API (re-exported from `websocket`): [`publish_user_notification`],
//! [`publish_copilot_ui_event`], [`publish_database_change`] (P-DB-29B-C).
//!
//! Extracted from `mod.rs` in P107-E.

use std::sync::{
  OnceLock,
  atomic::{AtomicBool, Ordering},
};
use tokio::sync::broadcast;
use uuid::Uuid;

use myoxus_domain::database_change::DatabaseChangeEvent;

use super::database_broadcast::database_change_wire_payload;
use super::types::{
  ClientUpdateControlChangedPayload, CopilotUiFanoutMessage, DatabaseChangeFanoutMessage, NotificationFanoutMessage,
};
use crate::client_update_runtime::ClientUpdateRuntime;
use socketioxide::SocketIo;
use std::sync::Arc;
use tracing::{debug, warn};

/// Broadcast sender for notification fan-out, initialized in [`super::init`] with the
/// configured channel capacity.
pub(super) static NOTIFICATION_FANOUT_TX: OnceLock<broadcast::Sender<NotificationFanoutMessage>> = OnceLock::new();

/// Broadcast sender for copilot UI fan-out, initialized in [`super::init`] with the
/// configured channel capacity.
pub(super) static COPILOT_UI_FANOUT_TX: OnceLock<broadcast::Sender<CopilotUiFanoutMessage>> = OnceLock::new();

/// Authenticated sockets consume one channel for Database-room changes and
/// identity-only workspace Task hints. Each message selects its existing
/// membership scope before delivery; no Project join fanout is introduced.
pub(super) static DATABASE_FANOUT_TX: OnceLock<broadcast::Sender<DatabaseChangeFanoutMessage>> = OnceLock::new();

pub(super) fn spawn_client_update_wakeup_forwarder(io: SocketIo, runtime: Arc<ClientUpdateRuntime>) {
  let mut wakeups = runtime.subscribe_wakeups();
  tokio::spawn(async move {
    loop {
      match wakeups.recv().await {
        Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
          if io
            .emit("client:update-control-changed", &ClientUpdateControlChangedPayload {})
            .await
            .is_err()
          {
            warn!("client update socket wake-up delivery failed");
          }
        }
        Err(broadcast::error::RecvError::Closed) => {
          debug!("client update socket wake-up forwarder stopped");
          break;
        }
      }
    }
  });
}

pub(super) fn notification_fanout_tx() -> &'static broadcast::Sender<NotificationFanoutMessage> {
  NOTIFICATION_FANOUT_TX
    .get()
    .expect("NOTIFICATION_FANOUT_TX not initialized — call websocket::init first")
}

pub(super) fn copilot_ui_fanout_tx() -> &'static broadcast::Sender<CopilotUiFanoutMessage> {
  COPILOT_UI_FANOUT_TX
    .get()
    .expect("COPILOT_UI_FANOUT_TX not initialized — call websocket::init first")
}

/// P-DB-29B-C: access the database change fanout channel. Returns
/// `None` if the WS layer has not been initialized yet; callers should
/// treat `None` as "no subscribers" and silently succeed.
pub(super) fn database_fanout_tx() -> Option<&'static broadcast::Sender<DatabaseChangeFanoutMessage>> {
  DATABASE_FANOUT_TX.get()
}

static NOTIFICATION_PUBLISH_FAILED: AtomicBool = AtomicBool::new(false);

/// Best-effort notification acceleration after the authoritative write commits.
/// Redis delivers to all instances, including origin. On transport failure only
/// local delivery survives; clients recover from persisted state on reload.
pub async fn publish_user_notification(
  adapter: Option<&super::redis_adapter::RedisWsAdapter>,
  user_id: Uuid,
  event_type: impl Into<String>,
  payload: serde_json::Value,
) -> String {
  let message = NotificationFanoutMessage {
    user_id,
    event_id: Uuid::new_v4().to_string(),
    event_type: event_type.into(),
    payload,
  };
  if let Some(adapter) = adapter {
    if adapter
      .try_publish_user_notification_to_all_instances(user_id, &message.event_id, &message.event_type, &message.payload)
      .await
      .is_ok()
    {
      NOTIFICATION_PUBLISH_FAILED.store(false, Ordering::Relaxed);
      return message.event_id;
    }
    if !NOTIFICATION_PUBLISH_FAILED.swap(true, Ordering::Relaxed) {
      warn!("notification cluster publish failed; persisted reload remains authoritative");
    }
  }
  let event_id = message.event_id.clone();
  deliver_user_notification_locally(message);
  event_id
}

/// Redis reception never republishes or regenerates the delivery identity.
pub(super) fn deliver_user_notification_locally(message: NotificationFanoutMessage) {
  if let Some(tx) = NOTIFICATION_FANOUT_TX.get() {
    let _ = tx.send(message);
  }
}

/// Enqueue a Copilot UI event (typing, partial, done, error) for real-time delivery.
///
/// Same broadcast pattern as notifications. The `event_type` is normalized to one
/// of the four allowed values; unknown types are mapped to "error" for safety.
pub fn publish_copilot_ui_event(
  user_id: Uuid,
  session_id: impl Into<String>,
  event_type: impl Into<String>,
  payload: serde_json::Value,
) -> String {
  let event_id = Uuid::new_v4().to_string();
  let event_type = normalize_copilot_event_type(&event_type.into());
  let message = CopilotUiFanoutMessage {
    user_id,
    event_id: event_id.clone(),
    session_id: session_id.into(),
    event_type,
    payload,
  };
  let _ = copilot_ui_fanout_tx().send(message);
  event_id
}

/// Sanitize the Copilot event type to one of the four allowed values.
/// Unknown types are mapped to "error" to prevent injection of arbitrary event names
/// into the client-side event handler.
pub(super) fn normalize_copilot_event_type(raw: &str) -> String {
  match raw {
    "typing" | "partial" | "done" | "error" => raw.to_string(),
    _ => "error".to_string(),
  }
}

/// P-DB-29B-C: enqueue a database change-event for delivery to every
/// socket that joined `database:join(database_id=event.database_id)`.
///
/// If the WS layer has not been initialized (e.g. early bootstrap or unit
/// tests), or no socket is subscribed, this function is a silent no-op.
/// Lagging receivers detect and report their own dropped messages; a missed
/// update is always reconcilable on the next `database:load` ACK.
pub fn publish_database_change(event: &DatabaseChangeEvent) {
  let Some(tx) = database_fanout_tx() else {
    return;
  };
  let message = DatabaseChangeFanoutMessage {
    workspace_id: event.workspace_id,
    database_id: event.database_id,
    payload: database_change_wire_payload(event),
    workspace_hint: false,
  };
  let _ = tx.send(message);
}

/// Use the existing authenticated socket fanout; membership is checked against
/// the same acknowledged space:join scope, without per-Database joins.
pub(super) fn publish_tasks_changed(event: &DatabaseChangeEvent, payload: serde_json::Value) {
  if let Some(tx) = database_fanout_tx() {
    let _ = tx.send(DatabaseChangeFanoutMessage {
      workspace_id: event.workspace_id,
      database_id: event.database_id,
      payload,
      workspace_hint: true,
    });
  }
}
