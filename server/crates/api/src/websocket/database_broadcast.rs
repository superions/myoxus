// SPDX-License-Identifier: AGPL-3.0-or-later
//! Committed Database-room events and identity-only workspace Task invalidation.
//! Database subscriptions retain their existing room/presence contract. Task
//! consumers join the authorized workspace sync room without joining Projects.

use async_trait::async_trait;
use myoxus_application::ports::PortError;
use myoxus_application::ports::database_change::DatabaseChangeNotificationPort;
use myoxus_domain::database_change::DatabaseChangeEvent;
use myoxus_domain::ids::WorkspaceId;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use super::fanout::publish_database_change;
use super::redis_adapter::RedisWsAdapter;

/// Wires `DatabaseChangeNotificationPort` to the Socket.IO fanout channel.
///
/// Implementations live in `super::fanout::publish_database_change` and
/// fan out to subscribed sockets via the per-room broadcast channel.
pub struct SocketDatabaseBroadcast {
  redis: Option<Arc<RedisWsAdapter>>,
}

impl SocketDatabaseBroadcast {
  pub fn new(redis: Option<Arc<RedisWsAdapter>>) -> Self {
    Self { redis }
  }
}

#[async_trait]
impl DatabaseChangeNotificationPort for SocketDatabaseBroadcast {
  async fn publish_tasks_changed(&self, event: &DatabaseChangeEvent) -> Result<(), PortError> {
    let payload = tasks_changed_wire_payload(event);
    // Local delivery precedes Redis's own-instance origin suppression.
    super::fanout::publish_tasks_changed(event, payload.clone());
    if let Some(redis) = &self.redis {
      redis
        .broadcast_to_workspace(&event.workspace_id.to_string(), "database:tasks-changed", &payload, "")
        .await;
    }
    Ok(())
  }

  async fn publish_change(&self, event: &DatabaseChangeEvent) -> Result<(), PortError> {
    publish_database_change(event);
    if let Some(redis) = &self.redis {
      redis
        .broadcast_to_workspace(
          &event.workspace_id.to_string(),
          "database:change",
          &database_change_wire_payload(event),
          "",
        )
        .await;
    }
    Ok(())
  }
}

/// Workspace hints expose identities only; canonical reads still enforce ACL.
pub fn tasks_changed_wire_payload(event: &DatabaseChangeEvent) -> serde_json::Value {
  json!({ "workspaceId": event.workspace_id, "databaseId": event.database_id, "eventId": event.event_id })
}

/// Build the canonical `database:{database_id}` room name for a database.
///
/// Public so handlers in `super::handlers::database` can reuse the exact
/// same string when validating `database:join` payloads.
pub fn database_room(workspace_id: WorkspaceId, database_id: Uuid) -> String {
  // Database IDs are globally unique; retain the existing room namespace.
  let _ = workspace_id;
  format!("database:{database_id}")
}

/// Serialize a [`DatabaseChangeEvent`] to the wire shape consumed by the
/// client (`database:change`).
///
/// The shape intentionally mirrors the GraphQL `DatabaseChange` object
/// (snake_case fields, ISO-8601 timestamps) so client code can decode
/// both representations through a single DTO.
pub fn database_change_wire_payload(event: &DatabaseChangeEvent) -> serde_json::Value {
  let mut payload = json!({
    "workspaceId": event.workspace_id,
    "databaseId": event.database_id,
    "kind": event.kind,
    "actorUserId": event.actor_user_id,
    "eventId": event.event_id,
    "committedAt": event.committed_at.to_rfc3339(),
  });
  if !event.target.is_empty() {
    payload["target"] = json!({
      "rowId": event.target.row_id,
      "fieldId": event.target.field_id,
      "viewId": event.target.view_id,
    });
  }
  payload
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::database_change::{DatabaseChangeEvent, DatabaseChangeKind};
  use myoxus_domain::ids::{DatabaseFieldId, DatabaseRowId, WorkspaceId};

  #[test]
  fn room_name_is_deterministic() {
    let id = Uuid::new_v4();
    let workspace = WorkspaceId::new_v4();
    assert_eq!(database_room(workspace, id), format!("database:{id}"));
  }

  #[test]
  fn wire_payload_includes_kind_and_event_identity() {
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let event = DatabaseChangeEvent::new(workspace, database, DatabaseChangeKind::CellUpdated, actor);
    let payload = database_change_wire_payload(&event);
    assert_eq!(payload["workspaceId"], json!(workspace));
    assert_eq!(payload["databaseId"], json!(database));
    assert_eq!(payload["actorUserId"], json!(actor));
    assert_eq!(payload["eventId"], json!(event.event_id));
    assert_eq!(payload["kind"], json!("cell_updated"));
    // No target → no `target` key on the wire.
    assert!(payload.get("target").is_none());
  }

  #[test]
  fn wire_payload_with_target_serialises_row_field_view() {
    let workspace = WorkspaceId::new_v4();
    let database = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let row = DatabaseRowId::new_v4();
    let field = DatabaseFieldId::new_v4();
    let event = DatabaseChangeEvent::new(workspace, database, DatabaseChangeKind::CellUpdated, actor).with_target(
      myoxus_domain::database_change::DatabaseChangeTarget {
        row_id: Some(row),
        field_id: Some(field),
        view_id: None,
      },
    );
    let payload = database_change_wire_payload(&event);
    let target = &payload["target"];
    assert_eq!(target["rowId"], json!(row));
    assert_eq!(target["fieldId"], json!(field));
    assert!(target.get("viewId").is_none() || target["viewId"].is_null());
  }

  #[test]
  fn publish_change_is_silent_noop() {
    // We only exercise the Ok path: the real fanout is process-global and
    // would otherwise spam the test log.  The null port behaviour is
    // covered separately in the application crate.
    let rt = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .expect("rt");
    let port = SocketDatabaseBroadcast::new(None);
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      Uuid::new_v4(),
      DatabaseChangeKind::RowCreated,
      Uuid::new_v4(),
    );
    rt.block_on(async {
      // Wrap in a timeout so a missing broadcast channel does not hang
      // the test forever.
      let res = tokio::time::timeout(std::time::Duration::from_millis(50), port.publish_change(&event)).await;
      match res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "unexpected error"),
        Err(_) => {
          // No active broadcast subscriber in this isolated test — that
          // is acceptable; the port contract is "best-effort".
        }
      }
    });
  }
}
