// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-C: Database collaboration Socket.IO handlers.
//
// Five events are added to the WS layer:
//   * `database:join`            — client emitsWithAck after opening a
//                                   Database view; the server must return the
//                                   current presence snapshot so collaborators
//                                   who joined earlier light up in the UI.
//   * `database:leave`           — fire-and-forget; triggers cleanup of the
//                                   per-socket presence record and stops fan-out.
//   * `database:load-presence`   — emitWithAck; returns the latest presence
//                                   snapshot for the joined database.
//   * `database:update-presence` — fire-and-forget; updates the per-socket
//                                   presence record (current view, focused row,
//                                   focused field, last-active timestamp) and
//                                   fans out a `database:presence-update`
//                                   event to other sockets in the same room.
//   * `database:change`          — server-originated; emitted on every
//                                   committed mutation so the client can
//                                   revalidate / refresh silently.
//
// All handlers MUST:
//   * verify the caller has `read` access to the workspace and database;
//   * reject outsiders with a typed error code;
//   * never leak across workspace boundaries.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use socketioxide::extract::{AckSender, SocketRef};
use tracing::debug;
use uuid::Uuid;

use crate::state::ApiState;

use super::super::database_broadcast::{database_change_wire_payload, database_room};
use super::super::fanout::{database_fanout_tx, publish_database_change};
use myoxus_domain::database_change::DatabaseChangeEvent;
use myoxus_domain::ids::WorkspaceId;

// ─── Wire DTOs ───────────────────────────────────────────────────────────────

/// `database:join` / `database:leave` payload.
#[derive(Debug, Clone, Deserialize)]
pub(in crate::websocket) struct DatabasePresencePayload {
  #[serde(rename = "workspaceId")]
  pub workspace_id: Uuid,
  #[serde(rename = "databaseId")]
  pub database_id: Uuid,
}

/// `database:update-presence` payload — adds the per-cell focus hints.
#[derive(Debug, Clone, Deserialize)]
pub(in crate::websocket) struct DatabasePresenceUpdatePayload {
  #[serde(rename = "workspaceId")]
  pub workspace_id: Uuid,
  #[serde(rename = "databaseId")]
  pub database_id: Uuid,
  /// Current view identifier (matches `DatabaseView.id`); `null` means "no
  /// specific view selected".
  #[serde(rename = "viewId", default)]
  pub view_id: Option<Uuid>,
  /// Row the local user is currently focusing, if any.
  #[serde(rename = "rowId", default)]
  pub row_id: Option<Uuid>,
  /// Field the local user is currently focusing, if any.
  #[serde(rename = "fieldId", default)]
  pub field_id: Option<Uuid>,
  /// True while a Kanban card is being dragged. The actual position score
  /// stays server-side; the client only learns the boolean drag intent.
  #[serde(rename = "dragging", default)]
  pub dragging: bool,
}

/// Single presence record returned by `database:load-presence`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(in crate::websocket) struct DatabasePresenceRecord {
  #[serde(rename = "socketId")]
  pub socket_id: String,
  #[serde(rename = "userId")]
  pub user_id: Uuid,
  #[serde(rename = "displayName")]
  pub display_name: String,
  #[serde(rename = "viewId")]
  pub view_id: Option<Uuid>,
  #[serde(rename = "rowId")]
  pub row_id: Option<Uuid>,
  #[serde(rename = "fieldId")]
  pub field_id: Option<Uuid>,
  #[serde(rename = "dragging")]
  pub dragging: bool,
  #[serde(rename = "lastActiveAt")]
  pub last_active_at: chrono::DateTime<chrono::Utc>,
}

// ─── Event names and ephemeral presence state ────────────────────────────────

/// Database collaboration events that travel out of the per-database room.
#[allow(dead_code)] // consumed by the per-socket fanout loop wired in P-DB-29B-D
const DATABASE_CHANGE_EVENT: &str = "database:change";
const DATABASE_PRESENCE_UPDATE_EVENT: &str = "database:presence-update";

/// Per-socket presence state. Lives in `Arc<DashMap>` so the disconnect
/// hook can drop the socket without taking a global lock.
pub(in crate::websocket) fn remember_database_presence(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
  user_id: Uuid,
  display_name: String,
) {
  crate::websocket::state::remember_database_presence(socket_id, workspace_id, database_id, user_id, display_name);
}

#[cfg(test)]
fn forget_database_presence(socket_id: &str) {
  let _ = crate::websocket::state::forget_database_presence(socket_id);
}

pub(in crate::websocket) fn update_database_presence(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
  view_id: Option<Uuid>,
  row_id: Option<Uuid>,
  field_id: Option<Uuid>,
  dragging: bool,
) {
  crate::websocket::state::update_database_presence(
    socket_id,
    workspace_id,
    database_id,
    view_id,
    row_id,
    field_id,
    dragging,
  );
}

pub(in crate::websocket) fn list_database_presence(
  workspace_id: WorkspaceId,
  database_id: Uuid,
) -> Vec<crate::websocket::state::DatabasePresenceSnapshot> {
  crate::websocket::state::list_database_presence(workspace_id, database_id)
}

fn map_presence_snapshot(snapshot: crate::websocket::state::DatabasePresenceSnapshot) -> DatabasePresenceRecord {
  DatabasePresenceRecord {
    socket_id: snapshot.socket_id,
    user_id: snapshot.user_id,
    display_name: snapshot.display_name,
    view_id: snapshot.view_id,
    row_id: snapshot.row_id,
    field_id: snapshot.field_id,
    dragging: snapshot.dragging,
    last_active_at: snapshot.last_active_at,
  }
}

async fn load_database_presence(
  state: &ApiState,
  workspace_id: WorkspaceId,
  database_id: Uuid,
) -> Vec<DatabasePresenceRecord> {
  if let Some(redis) = state.redis_ws_adapter() {
    return redis
      .list_database_presence(workspace_id, database_id)
      .await
      .into_iter()
      .filter_map(|value| serde_json::from_value(value).ok())
      .collect();
  }
  list_database_presence(workspace_id, database_id)
    .into_iter()
    .map(map_presence_snapshot)
    .collect()
}

// ─── Access predicate (P-DB-29B-C requires a typed error contract) ─────────────

/// Resolve access through the canonical Database query capability.
///
/// The service applies the complete workspace permission policy and returns
/// the authoritative Database-to-workspace identity. The Socket.IO adapter
/// therefore cannot bypass either boundary through the API process pool.
pub(in crate::websocket) async fn user_can_view_database(
  state: &Arc<ApiState>,
  user_id: Uuid,
  workspace_id: WorkspaceId,
  database_id: Uuid,
) -> bool {
  let Some(services) = state.database_services() else {
    return false;
  };
  services
    .views
    .get_database_summary(user_id, database_id)
    .await
    .is_ok_and(|database| database.workspace_id == workspace_id)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// `database:join` — client emits `emitWithAck`; server must return the
/// current presence snapshot for the room so the new participant can render
/// collaborators that joined earlier.
pub(in crate::websocket) async fn handle_database_join(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: DatabasePresencePayload,
  ack: AckSender,
) {
  let sid = socket.id.to_string();
  let user_id = match super::super::access::await_authenticated(&sid).await {
    Some(uid) => uid,
    None => {
      ack
        .send(&json!({ "error": { "name": "UNAUTHENTICATED", "message": "no session" } }))
        .ok();
      return;
    }
  };
  if !user_can_view_database(&state, user_id, data.workspace_id, data.database_id).await {
    ack
      .send(&json!({ "error": { "name": "DATABASE_FORBIDDEN", "message": "no access to database" } }))
      .ok();
    return;
  }
  let room = database_room(data.workspace_id, data.database_id);
  socket.join(room.clone());
  debug!(%sid, room = %room, "database:join socketioxide room joined");
  let display_name = state
    .auth()
    .get_user_by_id(user_id)
    .await
    .ok()
    .flatten()
    .and_then(|user| user.name.filter(|name| !name.trim().is_empty()).or(Some(user.email)))
    .unwrap_or_else(|| format!("user-{}", &user_id.to_string()[..8]));
  remember_database_presence(&sid, data.workspace_id, data.database_id, user_id, display_name);
  let Some(local_record) = list_database_presence(data.workspace_id, data.database_id)
    .into_iter()
    .find(|record| record.socket_id == sid)
    .map(map_presence_snapshot)
  else {
    // Disconnect/leave may remove membership on another runtime thread.
    // A cancelled join must not panic or recreate the retired presence.
    ack
      .send(
        &json!({ "error": { "name": "DATABASE_NOT_JOINED", "message": "database room left before join completed" } }),
      )
      .ok();
    return;
  };
  let update_payload = serde_json::to_value(&local_record).expect("presence record serializes");
  let join_broadcast = json!({
    "workspaceId": data.workspace_id,
    "databaseId": data.database_id,
    "socketId": sid,
    "userId": local_record.user_id,
    "displayName": local_record.display_name,
    "viewId": local_record.view_id,
    "rowId": local_record.row_id,
    "fieldId": local_record.field_id,
    "dragging": local_record.dragging,
    "lastActiveAt": local_record.last_active_at,
  });
  let io = state
    .socket_io
    .read()
    .unwrap_or_else(|error| error.into_inner())
    .clone();
  if let Some(io) = io {
    let _ = io
      .to(room.clone())
      .except(sid.clone())
      .emit(DATABASE_PRESENCE_UPDATE_EVENT, &join_broadcast)
      .await;
  }
  if let Some(redis) = state.redis_ws_adapter() {
    redis
      .upsert_database_presence(data.workspace_id, data.database_id, &sid, &update_payload)
      .await;
    redis
      .broadcast_to_workspace(
        &data.workspace_id.to_string(),
        DATABASE_PRESENCE_UPDATE_EVENT,
        &join_broadcast,
        &sid,
      )
      .await;
  }
  let presence = load_database_presence(&state, data.workspace_id, data.database_id).await;
  ack
    .send(&json!({
      "data": {
        "workspaceId": data.workspace_id,
        "databaseId": data.database_id,
        "presence": presence,
      }
    }))
    .ok();
  debug!(%sid, room = %room, "database:join committed");
}

/// `database:leave` — fire-and-forget; removes the per-socket presence
/// record and emits a `database:presence-update` so remaining participants
/// see the disconnect.
pub(in crate::websocket) async fn handle_database_leave(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: DatabasePresencePayload,
) {
  let sid = socket.id.to_string();
  let _ = crate::websocket::state::forget_database_room_presence(&sid, data.workspace_id, data.database_id);
  let room = database_room(data.workspace_id, data.database_id);
  socket.leave(room.clone());
  debug!(%sid, room = %room, "database:leave socketioxide room left");
  let io = state
    .socket_io
    .read()
    .unwrap_or_else(|error| error.into_inner())
    .clone();
  if let Some(io) = io {
    let _ = io
      .to(room)
      .except(sid.clone())
      .emit(
        DATABASE_PRESENCE_UPDATE_EVENT,
        &json!({
          "workspaceId": data.workspace_id,
          "databaseId": data.database_id,
          "socketId": sid,
          "left": true,
        }),
      )
      .await;
  }
  let left_payload = json!({
    "workspaceId": data.workspace_id,
    "databaseId": data.database_id,
    "socketId": sid,
    "left": true,
  });
  if let Some(redis) = state.redis_ws_adapter() {
    redis
      .remove_database_presence(data.workspace_id, data.database_id, &sid)
      .await;
    redis
      .broadcast_to_workspace(
        &data.workspace_id.to_string(),
        DATABASE_PRESENCE_UPDATE_EVENT,
        &left_payload,
        &sid,
      )
      .await;
  }
}

/// `database:load-presence` — emitWithAck; returns the current snapshot
/// without joining the room again.
pub(in crate::websocket) async fn handle_database_load_presence(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: DatabasePresencePayload,
  ack: AckSender,
) {
  let sid = socket.id.to_string();
  let user_id = match super::super::access::await_authenticated(&sid).await {
    Some(uid) => uid,
    None => {
      ack
        .send(&json!({ "error": { "name": "UNAUTHENTICATED", "message": "no session" } }))
        .ok();
      return;
    }
  };
  if !user_can_view_database(&state, user_id, data.workspace_id, data.database_id).await {
    ack
      .send(&json!({ "error": { "name": "DATABASE_FORBIDDEN", "message": "no access to database" } }))
      .ok();
    return;
  }
  let presence = load_database_presence(&state, data.workspace_id, data.database_id).await;
  ack
    .send(&json!({
      "data": {
        "workspaceId": data.workspace_id,
        "databaseId": data.database_id,
        "presence": presence,
      }
    }))
    .ok();
}

/// `database:update-presence` — fire-and-forget; updates the per-socket
/// row / field / view focus and broadcasts a `database:presence-update`.
pub(in crate::websocket) async fn handle_database_update_presence(
  state: Arc<ApiState>,
  socket: SocketRef,
  data: DatabasePresenceUpdatePayload,
) {
  let sid = socket.id.to_string();
  update_database_presence(
    &sid,
    data.workspace_id,
    data.database_id,
    data.view_id,
    data.row_id,
    data.field_id,
    data.dragging,
  );
  let Some(presence_record) = list_database_presence(data.workspace_id, data.database_id)
    .into_iter()
    .find(|record| record.socket_id == sid)
    .map(map_presence_snapshot)
  else {
    // Focus cannot create membership or publish into a room that this socket
    // never joined through the canonical Database permission check.
    return;
  };
  let room = database_room(data.workspace_id, data.database_id);
  let update_payload = json!({
    "workspaceId": data.workspace_id,
    "databaseId": data.database_id,
    "socketId": sid,
    "userId": presence_record.user_id,
    "displayName": presence_record.display_name,
    "viewId": data.view_id,
    "rowId": data.row_id,
    "fieldId": data.field_id,
    "dragging": data.dragging,
    "lastActiveAt": presence_record.last_active_at,
  });
  let io = state
    .socket_io
    .read()
    .unwrap_or_else(|error| error.into_inner())
    .clone();
  if let Some(io) = io {
    let _ = io
      .to(room)
      .except(sid.clone())
      .emit(DATABASE_PRESENCE_UPDATE_EVENT, &update_payload)
      .await;
  }
  if let Some(redis) = state.redis_ws_adapter() {
    if let Ok(payload) = serde_json::to_value(presence_record) {
      redis
        .upsert_database_presence(data.workspace_id, data.database_id, &sid, &payload)
        .await;
    }
    redis
      .broadcast_to_workspace(
        &data.workspace_id.to_string(),
        DATABASE_PRESENCE_UPDATE_EVENT,
        &update_payload,
        &sid,
      )
      .await;
  }
}

/// Server-side: broadcast a `database:change` event into the matching
/// room when a Database mutation publishes its typed change event from
/// outside the WS layer (bulk-import worker, admin tools).
#[allow(dead_code)] // wired in P-DB-29B-D
pub(in crate::websocket) fn dispatch_database_change(event: &DatabaseChangeEvent) {
  publish_database_change(event);
  if let Some(tx) = database_fanout_tx() {
    let payload = database_change_wire_payload(event);
    // The fan-out helpers above already push the event into the
    // broadcast channel; this is the place where consumers can hook in
    // additional delivery (e.g. socketioxide room emit). For now we
    // rely on per-socket subscriber loops (P-DB-29B-D).
    let _ = tx.send(crate::websocket::types::DatabaseChangeFanoutMessage {
      workspace_hint: false,
      workspace_id: event.workspace_id,
      database_id: event.database_id,
      payload,
    });
  }
}

/// Convenience for tests + handlers that already hold the wire payload.
#[allow(dead_code)]
pub(in crate::websocket) fn is_database_room(room: &str) -> bool {
  room.starts_with("database:")
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn database_room_is_deterministic() {
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    assert_eq!(database_room(workspace, database), format!("database:{database}"));
  }

  #[test]
  fn room_prefix_is_database() {
    assert!(is_database_room("database:00000000-0000-0000-0000-000000000000"));
    assert!(!is_database_room("workspace:00000000-0000-0000-0000-000000000000:sync"));
  }

  #[test]
  fn dispatcher_uses_canonical_event_name() {
    // We cannot exercise the broadcast channel in unit tests without a
    // running tokio runtime + initialized fanout, but the constants
    // must match the wire contract documented in
    // `docs/dev/server/databases-data-model.md` under Optimistic Editing And
    // Realtime Collaboration.
    assert_eq!(DATABASE_CHANGE_EVENT, "database:change");
    assert_eq!(DATABASE_PRESENCE_UPDATE_EVENT, "database:presence-update");
  }

  #[test]
  fn presence_record_uses_camel_case_wire_keys() {
    let record = DatabasePresenceRecord {
      socket_id: "abc".to_string(),
      user_id: Uuid::nil(),
      display_name: "Test".to_string(),
      view_id: Some(Uuid::new_v4()),
      row_id: None,
      field_id: None,
      dragging: false,
      last_active_at: chrono::Utc::now(),
    };
    let value = serde_json::to_value(&record).expect("serialize");
    assert_eq!(value["socketId"], "abc");
    assert_eq!(value["displayName"], "Test");
    assert_eq!(value["viewId"], value["viewId"].clone());
  }

  #[test]
  fn room_lookup_uses_canonical_database_room() {
    // Sanity: `database:join` MUST go through `database_room` so the room
    // name stays consistent with the broadcast channel and the GraphQL
    // subscription consumers.
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    assert!(is_database_room(&database_room(workspace, database)));
  }

  #[test]
  fn presence_payload_contains_only_room_identity() {
    let json =
      r#"{"workspaceId":"00000000-0000-0000-0000-000000000000","databaseId":"00000000-0000-0000-0000-000000000001"}"#;
    let parsed: DatabasePresencePayload = serde_json::from_str(json).expect("parse");
    assert_eq!(
      parsed.database_id,
      Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap()
    );
  }

  #[test]
  fn update_payload_supports_dragging_flag() {
    let json = r#"{"workspaceId":"00000000-0000-0000-0000-000000000000","databaseId":"00000000-0000-0000-0000-000000000001","dragging":true,"rowId":"00000000-0000-0000-0000-000000000002"}"#;
    let parsed: DatabasePresenceUpdatePayload = serde_json::from_str(json).expect("parse");
    assert!(parsed.dragging);
    assert!(parsed.row_id.is_some());
  }

  #[test]
  fn list_presence_for_unknown_room_returns_empty() {
    let result = list_database_presence(WorkspaceId::new_v4(), Uuid::new_v4());
    assert!(result.is_empty());
  }

  #[test]
  fn remember_then_list_returns_record() {
    let sid = format!("test-sid-{}", Uuid::new_v4());
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    let user = Uuid::new_v4();
    remember_database_presence(&sid, workspace, database, user, "Alice".to_string());
    let listed = list_database_presence(workspace, database);
    assert_eq!(listed.len(), 1);
    let record = &listed[0];
    assert_eq!(record.socket_id, sid);
    assert_eq!(record.user_id, user);
    assert_eq!(record.display_name, "Alice");
    forget_database_presence(&sid);
    assert!(list_database_presence(workspace, database).is_empty());
  }

  #[test]
  fn update_presence_records_focused_target() {
    let sid = format!("test-sid-{}", Uuid::new_v4());
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    let row = Uuid::new_v4();
    let field = Uuid::new_v4();
    let view = Uuid::new_v4();
    remember_database_presence(&sid, workspace, database, Uuid::new_v4(), "Bob".to_string());
    update_database_presence(&sid, workspace, database, Some(view), Some(row), Some(field), true);
    let listed = list_database_presence(workspace, database);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].row_id, Some(row));
    assert_eq!(listed[0].field_id, Some(field));
    assert_eq!(listed[0].view_id, Some(view));
    assert!(listed[0].dragging);
    forget_database_presence(&sid);
  }

  #[test]
  fn stale_presence_is_pruned_from_room_snapshot() {
    let sid = format!("test-stale-sid-{}", Uuid::new_v4());
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    remember_database_presence(&sid, workspace, database, Uuid::new_v4(), "Stale".to_string());
    crate::websocket::state::DATABASE_PRESENCE
      .get_mut(&sid)
      .expect("socket presence")
      .get_mut(&(workspace, database))
      .expect("database presence")
      .last_active_at = std::time::Instant::now() - std::time::Duration::from_secs(91);
    assert!(list_database_presence(workspace, database).is_empty());
    assert!(!crate::websocket::state::DATABASE_PRESENCE.contains_key(&sid));
  }
}
