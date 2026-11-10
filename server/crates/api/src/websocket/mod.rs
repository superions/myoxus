//! socketioxide-based real-time collaboration layer (storage protocol).
//!
//! # Architecture
//!
//! This module is the Socket.IO event surface for the Myoxus web client. It
//! handles all real-time sync operations: `space:join`, `space:load-doc`,
//! `space:push-doc-update`, `space:load-doc-timestamps`, `space:join-awareness`,
//! `space:update-awareness`, `space:leave`, `space:delete-doc`, plus
//! notification and Copilot fan-out channels.
//!
//! ## Connection lifecycle
//!
//! 1. Client opens a Socket.IO connection to `/`
//! 2. `auth_middleware` runs BEFORE `on_connect` — authenticates via
//!    `handshake.auth.token` (Desktop/Mobile) or HTTP cookie (Web)
//! 3. `on_connect` registers all event handlers and starts per-socket
//!    notification/Copilot fanout loops (via `tokio::broadcast`)
//! 4. Client emits `space:join` with a `clientVersion` — this determines
//!    the sync protocol variant (0.25 single-update vs 0.26 batched)
//! 5. Doc operations (`load-doc`, `push-doc-update`) auto-join the space
//!    via `ensure_space_joined` if the client races ahead of `space:join`
//! 6. On disconnect, all DashMap entries for the socket are cleaned up,
//!    and Redis session memberships are removed asynchronously
//!
//! ## State management
//!
//! Per-socket state is stored in process-local `DashMap`s (see below).
//! Cross-instance coordination (multi-server deployments) is handled by
//! the optional `RedisWsAdapter` — see [`redis_adapter`] for details.
//!
//! ## Protocol versioning
//!
//! Clients with version >= 0.26.0 use the batched `space:broadcast-doc-updates`
//! event (multiple updates per message, optional compression). Older clients
//! use `space:broadcast-doc-update` (single update per message). Both are
//! supported simultaneously via separate socketioxide rooms per workspace.
//!
//! ACK-based events use [`AckSender`] per the socketioxide pattern.

pub(super) mod access;
pub(super) mod analytics;
pub(super) mod auth;
pub mod calendar_broadcast;
pub mod circuit_breaker;
pub mod database_broadcast;
pub(super) mod error;
pub(super) mod fanout;
pub(super) mod handlers;
pub mod redis_adapter;
pub mod reminder_socket;
pub(super) mod room;
pub(super) mod state;
pub(super) mod types;

#[cfg(test)]
mod tests;

pub use calendar_broadcast::SocketCalendarBroadcast;
pub use database_broadcast::SocketDatabaseBroadcast;
pub use fanout::{publish_copilot_ui_event, publish_database_change, publish_user_notification};
pub use reminder_socket::SocketReminderPort;

fn user_notification_local_event(
  broadcast: &redis_adapter::CrossInstanceBroadcast,
) -> Option<types::NotificationFanoutMessage> {
  if broadcast.event != redis_adapter::XWS_NOTIFICATION_REDIS_EVENT {
    return None;
  }
  let user_id = uuid::Uuid::parse_str(broadcast.workspace_id.strip_prefix("user:")?).ok()?;
  let envelope: types::NotificationPushEnvelope = serde_json::from_value(broadcast.payload.clone()).ok()?;
  uuid::Uuid::parse_str(&envelope.event_id).ok()?;
  if !matches!(
    envelope.event_type.as_str(),
    "notification_new" | "notification_read" | "notification_read_all" | "calendar_reminder_due"
  ) || !envelope.payload.is_object()
  {
    return None;
  }
  if let Some(recipient) = envelope.payload.get("userId") {
    if recipient.as_str().and_then(|id| uuid::Uuid::parse_str(id).ok()) != Some(user_id) {
      return None;
    }
  }
  Some(types::NotificationFanoutMessage {
    user_id,
    event_id: envelope.event_id,
    event_type: envelope.event_type,
    payload: envelope.payload,
  })
}

/// Document fanout must retain the producer's space; malformed scope never
/// falls back to a workspace room. Redis channel/envelope matching is checked
/// by the adapter before this payload validation.
fn document_broadcast_space(broadcast: &redis_adapter::CrossInstanceBroadcast) -> Option<SpaceType> {
  let space_id = broadcast.payload.get("spaceId")?.as_str()?;
  if space_id != broadcast.workspace_id {
    return None;
  }
  uuid::Uuid::parse_str(space_id).ok()?;
  myoxus_domain::document_key::DocumentKey::parse(broadcast.payload.get("docId")?.as_str()?).ok()?;
  serde_json::from_value(broadcast.payload.get("spaceType")?.clone()).ok()
}

/// Awareness never falls back to a generic sync room, including malformed updates.
fn awareness_broadcast_room(broadcast: &redis_adapter::CrossInstanceBroadcast) -> Option<String> {
  let space_type = document_broadcast_space(broadcast)?;
  if broadcast.event == "space:broadcast-awareness-update"
    && broadcast.payload.get("awarenessUpdate")?.as_str()?.is_empty()
  {
    return None;
  }
  let doc_id = broadcast.payload.get("docId")?.as_str()?;
  Some(get_room(
    space_type,
    &broadcast.workspace_id,
    &format!("{doc_id}:awareness"),
  ))
}

/// Bridges committed auth-session revocations to process-local socket load
/// cancellation without making the application layer depend on Socket.IO.
pub struct WebsocketSessionRevocationObserver;

impl myoxus_application::auth::SessionRevocationObserver for WebsocketSessionRevocationObserver {
  fn session_revoked(&self, session_id: uuid::Uuid) {
    state::cancel_session_doc_loads(session_id);
  }

  fn user_sessions_revoked(&self, user_id: uuid::Uuid, _session_ids: &[uuid::Uuid]) {
    state::cancel_user_doc_loads(user_id);
  }
}

/// Cooperatively stop every in-process document materializer before graceful
/// API shutdown begins draining connections.
pub fn cancel_all_doc_loads_for_shutdown() -> usize {
  state::cancel_all_doc_loads()
}

use analytics::*;
use auth::*;
use fanout::*;
use handlers::awareness;
use handlers::copilot;
use handlers::database;
use handlers::disconnect;
use handlers::doc::{dispatch_delete_doc, dispatch_load_doc, dispatch_load_doc_timestamps, dispatch_push_update};
use handlers::notification;
use handlers::space;
use handlers::subscriptions;
use handlers::telemetry;
use room::*;
use state::*;
use types::*;

use crate::state::ApiState;

use socketioxide::{
  SocketIo,
  extract::{AckSender, Data, SocketRef, State as SioState},
  handler::ConnectHandler,
  layer::SocketIoLayer,
};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{debug, error, info, trace, warn};

/// Broadcast a server-authored workspace-document update through the same
/// protocol rooms and Redis fan-out used by client-authored sync updates.
/// The update must already be durably persisted before this function is called.
async fn try_broadcast_server_workspace_doc_update(
  state: &ApiState,
  workspace_id: uuid::Uuid,
  document_key: &str,
  update: &[u8],
  editor: uuid::Uuid,
) -> Result<(), String> {
  use base64::{Engine as _, engine::general_purpose::STANDARD};

  // Committed outbox delivery wakes MCP even without a connected Web socket.
  state.resource_updates.wake(workspace_id);
  let workspace_id = workspace_id.to_string();
  let update = STANDARD.encode(update);
  let timestamp = chrono::Utc::now().timestamp_millis();
  let editor = editor.to_string();
  let payload_v25 = BroadcastDocUpdateV25 {
    space_type: SpaceType::Workspace,
    space_id: workspace_id.clone(),
    doc_id: document_key.to_string(),
    update: update.clone(),
    timestamp,
    editor: editor.clone(),
  };
  let payload_v26 = BroadcastDocUpdatesV26 {
    space_type: SpaceType::Workspace,
    space_id: workspace_id.clone(),
    doc_id: document_key.to_string(),
    updates: vec![update],
    timestamp,
    editor: editor.clone(),
    compressed: false,
  };

  let io = state
    .socket_io
    .read()
    .unwrap_or_else(|error| error.into_inner())
    .clone();
  if let Some(io) = io {
    if let Err(error) = io
      .to(get_room(SpaceType::Workspace, &workspace_id, "sync-025"))
      .emit("space:broadcast-doc-update", &payload_v25)
      .await
    {
      return Err(format!("server-authored v25 document broadcast failed: {error}"));
    }
    if let Err(error) = io
      .to(get_room(SpaceType::Workspace, &workspace_id, "sync-026"))
      .emit("space:broadcast-doc-updates", &payload_v26)
      .await
    {
      return Err(format!("server-authored v26 document broadcast failed: {error}"));
    }
  }

  if let Some(redis) = state.redis_ws_adapter() {
    let sender = format!("server:{editor}");
    let payload_v25 = serde_json::to_value(&payload_v25).map_err(|error| error.to_string())?;
    let payload_v26 = serde_json::to_value(&payload_v26).map_err(|error| error.to_string())?;
    redis
      .try_broadcast_to_workspace(&workspace_id, "space:broadcast-doc-update", &payload_v25, &sender)
      .await?;
    redis
      .try_broadcast_to_workspace(&workspace_id, "space:broadcast-doc-updates", &payload_v26, &sender)
      .await?;
  }
  Ok(())
}

pub(crate) async fn broadcast_server_workspace_doc_update(
  state: &ApiState,
  workspace_id: uuid::Uuid,
  doc_id: uuid::Uuid,
  update: &[u8],
  editor: uuid::Uuid,
) {
  if let Err(error) =
    try_broadcast_server_workspace_doc_update(state, workspace_id, &doc_id.to_string(), update, editor).await
  {
    warn!(%workspace_id, %doc_id, %error, "server-authored document broadcast failed");
  }
}

/// Publish a persisted server-authored update for outbox replay.
///
/// This public adapter intentionally accepts only the persisted delta and its
/// client-visible document key. Callers must resolve the internal outbox
/// identity through `docs.external_id` while holding the claim transaction;
/// duplicate delivery is harmless because Yjs updates are idempotent.
pub async fn publish_persisted_workspace_doc_update(
  state: &ApiState,
  workspace_id: uuid::Uuid,
  document_key: &str,
  update: &[u8],
  editor: uuid::Uuid,
) -> Result<(), String> {
  try_broadcast_server_workspace_doc_update(state, workspace_id, document_key, update, editor).await
}

/// Best-effort live invalidation; reconnect reads durable deletion evidence.
pub async fn publish_workspace_doc_deletions(
  state: &ApiState,
  workspace_id: uuid::Uuid,
  summary: &myoxus_application::doc::PermanentDeleteSummary,
) {
  use myoxus_application::doc::PermanentDeleteStatus;
  let space_id = workspace_id.to_string();
  let io = state.socket_io.read().unwrap_or_else(|e| e.into_inner()).clone();
  for doc in &summary.documents {
    if doc.status != PermanentDeleteStatus::Deleted {
      continue;
    }
    let payload = serde_json::json!({ "spaceType": "workspace", "spaceId": space_id, "docId": doc.client_doc_id });
    if let Some(io) = &io {
      if let Err(error) = io
        .to(format!("workspace:{}:sync", space_id))
        .emit("space:doc-delete", &payload)
        .await
      {
        tracing::warn!(%workspace_id, %error, "document deletion broadcast failed");
      }
    }
    if let Some(adapter) = state.redis_ws_adapter() {
      adapter
        .broadcast_to_workspace(&space_id, "space:doc-delete", &payload, "")
        .await;
    }
  }
}

// P102-VIEW-02: DOC_VIEW_DEDUP and DOC_VIEW_DEDUP_DATE now live in
// `myoxus_application::doc::load` (moved in P102-VIEW-01) so all call sites
// (WS, REST, MCP) share the same process-level dedup set.
// Used by the inline #[cfg(test)] suite below; runtime eviction lives in
// `analytics::flush_analytics`.
#[cfg(test)]
use myoxus_application::doc::{DOC_VIEW_DEDUP, DOC_VIEW_DEDUP_DATE};

/// Runtime switches for Socket.IO initialization.
///
/// Production must keep background tasks enabled so analytics and Redis
/// cross-instance fan-out stay live. Integration tests can build many routers
/// in one process; disabling only these long-lived loops keeps the Socket.IO
/// layer and handlers testable without retaining stale `ApiState`/PgPool
/// instances after the owning test has finished.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeOptions {
  pub spawn_background_tasks: bool,
  pub spawn_client_update_listener: bool,
}

impl Default for RuntimeOptions {
  fn default() -> Self {
    Self {
      spawn_background_tasks: true,
      spawn_client_update_listener: true,
    }
  }
}

/// Initialize the Socket.IO layer and register all event handlers.
///
/// Sets up the socketioxide engine with:
/// 1. Broadcast channels for notification and Copilot fan-out
/// 2. The `/` namespace with `auth_middleware` + `on_connect`
/// 3. A periodic analytics flush task (active user counts per workspace)
/// 4. (Optional) A Redis Pub/Sub subscriber for cross-instance doc broadcasts
///
/// Returns the Axum layer and the SocketIo handle (for embedding in the router).
pub fn init(state: Arc<ApiState>) -> (SocketIoLayer, SocketIo) {
  init_with_options(state, RuntimeOptions::default())
}

/// Initialize the Socket.IO layer with explicit runtime behavior.
///
/// This keeps the test-only background-task decision out of the product router
/// while still constructing the exact same Socket.IO layer, namespace and event
/// handlers that HTTP/WebSocket integration tests exercise.
pub fn init_with_options(state: Arc<ApiState>, options: RuntimeOptions) -> (SocketIoLayer, SocketIo) {
  // Initialize broadcast channels with configured capacity.
  let capacity = state.config.websocket.broadcast_channel_capacity;
  NOTIFICATION_FANOUT_TX.get_or_init(|| {
    let (tx, _) = broadcast::channel(capacity);
    tx
  });
  COPILOT_UI_FANOUT_TX.get_or_init(|| {
    let (tx, _) = broadcast::channel(capacity);
    tx
  });
  // P-DB-29B-C: database change broadcast channel. Reuses the same
  // capacity because change events fire at most once per committed
  // mutation; bursts of bulk-import rows are collapsed by the worker
  // (one `BulkImported` event per import job).
  DATABASE_FANOUT_TX.get_or_init(|| {
    let (tx, _) = broadcast::channel(capacity);
    tx
  });

  let max_payload = state.config.websocket.max_http_buffer_size();
  let eio_ping_interval = std::time::Duration::from_secs(state.config.websocket.eio_ping_interval_seconds);
  let eio_ping_timeout = std::time::Duration::from_secs(state.config.websocket.eio_ping_timeout_seconds);
  info!(
    ?eio_ping_interval,
    ?eio_ping_timeout,
    max_payload,
    "initializing socket.io engine"
  );
  let (layer, io) = SocketIo::builder()
    .ping_interval(eio_ping_interval)
    .ping_timeout(eio_ping_timeout)
    .max_payload(max_payload)
    .with_state(state.clone())
    .build_layer();

  io.ns(
    "/",
    (|socket: SocketRef, SioState(state): SioState<Arc<ApiState>>| async move {
      on_connect(socket, state);
    })
    .with(auth_middleware),
  );

  if options.spawn_client_update_listener {
    if let Some(runtime) = state.client_update_runtime() {
      runtime.start_listener();
      spawn_client_update_wakeup_forwarder(io.clone(), runtime);
    } else {
      warn!("client update listener not started because PostgreSQL runtime is unavailable");
    }
  }

  if options.spawn_background_tasks {
    let s_analytics = state.clone();
    let ping_secs = state.config.websocket.ping_interval_seconds;
    tokio::spawn(async move {
      let mut interval = tokio::time::interval(std::time::Duration::from_secs(ping_secs));
      loop {
        interval.tick().await;
        flush_analytics(&s_analytics).await;
      }
    });

    // SC-M-01: Start Redis Pub/Sub subscriber for cross-instance doc broadcasts.
    // When a remote instance publishes a doc update, the subscriber forwards it
    // to local socketioxide rooms so all connected clients see the update.
    if let Some(adapter) = state.redis_ws_adapter() {
      let adapter = adapter.clone();
      let io_for_sub = io.clone();
      let resource_updates = state.resource_updates.clone();
      tokio::spawn(async move {
        match adapter.start_subscriber().await {
          Ok(mut rx) => {
            info!("SC-M-01: cross-instance broadcast subscriber started");
            while let Some(broadcast) = rx.recv().await {
              match calendar_broadcast::classify_redis_calendar_broadcast(&broadcast) {
                calendar_broadcast::CalendarRedisBroadcast::Event {
                  workspace_id,
                  event_id,
                  op,
                } => {
                  if calendar_broadcast::emit_calendar_event_to_workspace(&io_for_sub, workspace_id, event_id, &op)
                    .await
                    .is_err()
                  {
                    warn!(
                      %workspace_id,
                      %event_id,
                      "cross-instance Calendar workspace-room fanout failed"
                    );
                  }
                  continue;
                }
                calendar_broadcast::CalendarRedisBroadcast::Invalid => continue,
                calendar_broadcast::CalendarRedisBroadcast::NotCalendar => {}
              }
              if broadcast.event == redis_adapter::XWS_NOTIFICATION_REDIS_EVENT {
                if let Some(message) = user_notification_local_event(&broadcast) {
                  deliver_user_notification_locally(message);
                }
                continue;
              }
              if matches!(
                broadcast.event.as_str(),
                "space:broadcast-awareness-update" | "space:collect-awareness"
              ) {
                if let Some(room) = awareness_broadcast_room(&broadcast) {
                  if let Err(error) = io_for_sub.to(room).emit(&broadcast.event, &broadcast.payload).await {
                    warn!(event = %broadcast.event, error = %error, "cross-instance awareness delivery failed");
                  }
                }
                // Reception is terminal: origin suppression belongs to the adapter,
                // and this branch must neither republish nor use the generic fallback.
                continue;
              }
              let space_type = match broadcast.event.as_str() {
                "space:broadcast-doc-update" | "space:broadcast-doc-updates" => {
                  let Some(space_type) = document_broadcast_space(&broadcast) else {
                    continue;
                  };
                  space_type
                }
                _ => {
                  // Other supported events are workspace-only. Some deployed
                  // delete/operation payloads carry only document/operation IDs;
                  // validate any supplied scope without inventing a userspace path.
                  if uuid::Uuid::parse_str(&broadcast.workspace_id).is_err()
                    || broadcast
                      .payload
                      .get("spaceType")
                      .is_some_and(|kind| kind.as_str() != Some("workspace"))
                    || ["spaceId", "workspaceId"].iter().any(|field| {
                      broadcast
                        .payload
                        .get(field)
                        .is_some_and(|id| id.as_str() != Some(broadcast.workspace_id.as_str()))
                    })
                  {
                    continue;
                  }
                  SpaceType::Workspace
                }
              };
              if matches!(space_type, SpaceType::Workspace)
                && let Ok(workspace) = uuid::Uuid::parse_str(&broadcast.workspace_id)
              {
                resource_updates.wake(workspace);
              }
              // Forward the existing protocol payload unchanged to the same
              // space kind joined by the authenticated producer/consumer.
              let room_sync = get_room(space_type, &broadcast.workspace_id, "sync");
              let room_025 = get_room(space_type, &broadcast.workspace_id, "sync-025");
              let room_026 = get_room(space_type, &broadcast.workspace_id, "sync-026");

              // Determine the target rooms based on the event name.
              let reconnect_after_publication =
                broadcast.event == myoxus_application::workspace_content_operation::coordination::WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT;
              let target_rooms = match broadcast.event.as_str() {
                "space:broadcast-doc-update" => vec![room_025],
                "space:broadcast-doc-updates" => vec![room_026],
                "space:doc-delete" | "database:tasks-changed" => vec![room_sync.clone()],
                myoxus_application::workspace_content_operation::coordination::WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT => {
                  vec![room_sync.clone()]
                }
                "database:change" | "database:presence-update" => broadcast
                  .payload
                  .get("databaseId")
                  .and_then(serde_json::Value::as_str)
                  .map(|database_id| vec![format!("database:{database_id}")])
                  .unwrap_or_default(),
                other => {
                  trace!(event = %other, "redis pubsub: unknown broadcast event, delivering to sync room");
                  vec![room_sync.clone()]
                }
              };

              for room in target_rooms {
                if let Err(e) = io_for_sub.to(room).emit(&broadcast.event, &broadcast.payload).await {
                  warn!(
                    event = %broadcast.event,
                    workspace_id = %broadcast.workspace_id,
                    error = %e,
                    "SC-M-01: failed to deliver cross-instance broadcast to local room"
                  );
                }
              }
              if reconnect_after_publication {
                for socket in io_for_sub.to(room_sync).sockets() {
                  if let Err(error) = socket.disconnect() {
                    warn!(
                      workspace_id = %broadcast.workspace_id,
                      %error,
                      "XWS could not close a published workspace sync session"
                    );
                  }
                }
              }
            }
            warn!("SC-M-01: cross-instance broadcast subscriber channel closed");
          }
          Err(e) => {
            error!(error = %e, "SC-M-01: failed to start cross-instance broadcast subscriber");
          }
        }
      });
    }
  } else {
    debug!("socket.io background tasks disabled for this router runtime");
  }

  (layer, io)
}

/// Socket.IO `on_connect` handler — registers all event handlers for the connection.
///
/// By the time this runs, `auth_middleware` has already authenticated the user
/// and stored their ID in `SOCKET_USER_MAP`. This function:
/// 1. Registers the disconnect cleanup handler (DashMap + optional Redis)
/// 2. Spawns per-socket notification and Copilot fanout loops
/// 3. Registers all event handlers (`space:join`, `space:load-doc`, etc.)
fn on_connect(socket: SocketRef, api_state: Arc<ApiState>) {
  debug!(sid = %socket.id, "new socket.io connection");

  // Socketioxide's except() excludes rooms, not socket IDs. Every connection
  // owns its SID room so existing local broadcasts can suppress their sender;
  // disconnect removes this membership with the socket's other rooms.
  socket.join(socket.id.to_string());

  // Event handlers are registered synchronously. Authentication is handled
  // by the auth_middleware (P32-A) BEFORE on_connect fires, so the user_id
  // is always available in SOCKET_USER_MAP when handlers execute.

  disconnect::register(&socket, api_state.clone());

  SOCKET_NOTIFICATION_SUBSCRIPTIONS.insert(socket.id.to_string(), false);
  SOCKET_COPILOT_SUBSCRIPTIONS.insert(socket.id.to_string(), false);
  subscriptions::spawn_socket_subscriptions(socket.clone(), api_state.clone());

  {
    let s = api_state.clone();
    socket.on(
      "telemetry:batch",
      move |socket: SocketRef, Data::<TelemetryBatchPayload>(data)| {
        let s = s.clone();
        async move { telemetry::handle_telemetry_batch(socket, data, s).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on("notification:subscribe", move |socket: SocketRef| {
      let s = s.clone();
      async move { notification::handle_notification_subscribe(s, socket).await }
    });
  }

  socket.on("copilot:subscribe", |socket: SocketRef| async move {
    copilot::handle_copilot_subscribe(socket).await
  });

  {
    let s = api_state.clone();
    socket.on(
      "notification:ack",
      move |socket: SocketRef, Data::<NotificationAckPayload>(data)| {
        let s = s.clone();
        async move { notification::handle_notification_ack(s, socket, data).await }
      },
    );
  }

  // space:join — client uses emitWithAck; must call AckSender, not emit a separate event
  {
    let s = api_state.clone();
    socket.on(
      "space:join",
      move |socket: SocketRef, Data::<JoinSpacePayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { space::handle_space_join(s, socket, data, ack).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "space:leave",
      move |socket: SocketRef, Data::<LeaveSpacePayload>(data)| {
        let s = s.clone();
        async move { space::handle_space_leave(s, socket, data).await }
      },
    );
  }

  // space:load-doc — client uses emitWithAck; must call AckSender
  {
    let s = api_state.clone();
    socket.on(
      "space:load-doc",
      move |socket: SocketRef, Data::<LoadDocPayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { dispatch_load_doc(s, socket, data, ack).await }
      },
    );
  }

  // space:push-doc-update — client uses emitWithAck; must call AckSender
  {
    let s = api_state.clone();
    socket.on(
      "space:push-doc-update",
      move |socket: SocketRef, Data::<PushDocUpdatePayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { dispatch_push_update(s, socket, data, ack).await }
      },
    );
  }

  // space:load-doc-timestamps — client uses emitWithAck; must call AckSender
  {
    let s = api_state.clone();
    socket.on(
      "space:load-doc-timestamps",
      move |socket: SocketRef, Data::<LoadDocTimestampsPayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { dispatch_load_doc_timestamps(s, socket, data, ack).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "space:delete-doc",
      move |socket: SocketRef, Data::<DeleteDocPayload>(data)| {
        let s = s.clone();
        async move { dispatch_delete_doc(s, socket, data).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "space:update-awareness",
      move |socket: SocketRef, Data::<UpdateAwarenessPayload>(data)| {
        let s = s.clone();
        async move { awareness::handle_update_awareness(s, socket, data).await }
      },
    );
  }

  // space:join-awareness — client uses emitWithAck; must call AckSender
  {
    let s = api_state.clone();
    socket.on(
      "space:join-awareness",
      move |socket: SocketRef, Data::<JoinAwarenessPayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { awareness::handle_join_awareness(s, socket, data, ack).await }
      },
    );
  }

  socket.on(
    "space:leave-awareness",
    |socket: SocketRef, Data::<AwarenessPayload>(data)| async move {
      awareness::handle_leave_awareness(socket, data).await
    },
  );

  {
    let s = api_state.clone();
    socket.on(
      "space:load-awarenesses",
      move |socket: SocketRef, Data::<AwarenessPayload>(data)| {
        let s = s.clone();
        async move { awareness::handle_load_awarenesses(s, socket, data).await }
      },
    );
  }

  // P-DB-29B-C: Database collaboration events.
  //
  // `database:join` requires AckSender so the client can hydrate the
  // collaborator snapshot before rendering. `database:leave` and
  // `database:update-presence` are fire-and-forget. `database:load-presence`
  // returns the snapshot on demand without re-joining the room.
  {
    let s = api_state.clone();
    socket.on(
      "database:join",
      move |socket: SocketRef, Data::<database::DatabasePresencePayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { database::handle_database_join(s, socket, data, ack).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "database:leave",
      move |socket: SocketRef, Data::<database::DatabasePresencePayload>(data)| {
        let s = s.clone();
        async move { database::handle_database_leave(s, socket, data).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "database:load-presence",
      move |socket: SocketRef, Data::<database::DatabasePresencePayload>(data), ack: AckSender| {
        let s = s.clone();
        async move { database::handle_database_load_presence(s, socket, data, ack).await }
      },
    );
  }

  {
    let s = api_state.clone();
    socket.on(
      "database:update-presence",
      move |socket: SocketRef, Data::<database::DatabasePresenceUpdatePayload>(data)| {
        let s = s.clone();
        async move { database::handle_database_update_presence(s, socket, data).await }
      },
    );
  }
}
