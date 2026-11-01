// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-04: Socket.IO implementation of `CalendarBroadcastPort`.
//!
//! `SocketCalendarBroadcast` is wired into `NativeEventService` in `bin/server.rs`
//! so every committed native-event mutation reaches local workspace sockets
//! immediately and remote API nodes through the existing socket Redis role.

use async_trait::async_trait;
use myoxus_application::calendar::CalendarBroadcastPort;
use myoxus_domain::ids::{CalendarEventId, WorkspaceId};
use serde_json::json;
use socketioxide::SocketIo;
use std::sync::{Arc, RwLock};
use tracing::warn;

use super::redis_adapter::{CrossInstanceBroadcast, RedisWsAdapter};
use super::room::get_room;
use super::types::{CalendarEventChangedEnvelope, SpaceType};

pub(super) const CALENDAR_EVENT_CHANGED: &str = "calendar:event_changed";
const CALENDAR_REDIS_SENDER: &str = "server:calendar";

/// Wires `CalendarBroadcastPort` directly to the local indexed Socket.IO room
/// and the existing cross-instance transport.
pub struct SocketCalendarBroadcast {
  redis: Option<Arc<RedisWsAdapter>>,
  socket_io: Arc<RwLock<Option<SocketIo>>>,
}

impl SocketCalendarBroadcast {
  pub fn new(redis: Option<Arc<RedisWsAdapter>>, socket_io: Arc<RwLock<Option<SocketIo>>>) -> Self {
    Self { redis, socket_io }
  }
}

pub(super) async fn emit_calendar_event_to_workspace(
  io: &SocketIo,
  workspace_id: WorkspaceId,
  event_id: CalendarEventId,
  op: &str,
) -> Result<(), ()> {
  let room = get_room(SpaceType::Workspace, &workspace_id.to_string(), "sync");
  let envelope = CalendarEventChangedEnvelope {
    event_id: event_id.to_string(),
    op: op.to_string(),
  };
  io.to(room)
    .emit(CALENDAR_EVENT_CHANGED, &envelope)
    .await
    .map_err(|_| ())
}

#[async_trait]
impl CalendarBroadcastPort for SocketCalendarBroadcast {
  async fn broadcast_event_changed(&self, workspace_id: WorkspaceId, event_id: CalendarEventId, op: &str) {
    let io = self.socket_io.read().unwrap_or_else(|error| error.into_inner()).clone();
    match io {
      Some(io) => {
        if emit_calendar_event_to_workspace(&io, workspace_id, event_id, op)
          .await
          .is_err()
        {
          warn!(
            %workspace_id,
            %event_id,
            op,
            "calendar local workspace-room fanout failed; clients can recover from PostgreSQL"
          );
        }
      }
      None => warn!(
        %workspace_id,
        %event_id,
        op,
        "calendar local workspace-room fanout unavailable; clients can recover from PostgreSQL"
      ),
    }

    let Some(redis) = self.redis.as_ref() else {
      return;
    };
    let payload = json!({
      "eventId": event_id,
      "op": op,
    });
    if redis
      .try_broadcast_to_workspace(
        &workspace_id.to_string(),
        CALENDAR_EVENT_CHANGED,
        &payload,
        CALENDAR_REDIS_SENDER,
      )
      .await
      .is_err()
    {
      // Calendar persistence has already committed. Redis is only the
      // best-effort realtime transport, and its raw error may contain a URL.
      warn!(
        %workspace_id,
        %event_id,
        op,
        "calendar realtime publish failed; clients can recover from PostgreSQL"
      );
    }
  }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum CalendarRedisBroadcast {
  NotCalendar,
  Invalid,
  Event {
    workspace_id: WorkspaceId,
    event_id: CalendarEventId,
    op: String,
  },
}

/// Validate and classify an event from the shared Redis socket bus.
///
/// Invalid Calendar events remain classified as Calendar so they cannot fall
/// through to generic room routing.
pub(super) fn classify_redis_calendar_broadcast(broadcast: &CrossInstanceBroadcast) -> CalendarRedisBroadcast {
  if broadcast.event != CALENDAR_EVENT_CHANGED {
    return CalendarRedisBroadcast::NotCalendar;
  }

  let Some(event_id) = broadcast.payload.get("eventId").and_then(serde_json::Value::as_str) else {
    warn!("discarding malformed cross-instance Calendar event");
    return CalendarRedisBroadcast::Invalid;
  };
  let Some(op) = broadcast.payload.get("op").and_then(serde_json::Value::as_str) else {
    warn!("discarding malformed cross-instance Calendar event");
    return CalendarRedisBroadcast::Invalid;
  };
  let (Ok(workspace_id), Ok(event_id)) = (
    WorkspaceId::parse_str(&broadcast.workspace_id),
    CalendarEventId::parse_str(event_id),
  ) else {
    warn!("discarding cross-instance Calendar event with invalid identifiers");
    return CalendarRedisBroadcast::Invalid;
  };
  if !matches!(op, "created" | "updated" | "deleted") {
    warn!("discarding cross-instance Calendar event with invalid operation");
    return CalendarRedisBroadcast::Invalid;
  }

  CalendarRedisBroadcast::Event {
    workspace_id,
    event_id,
    op: op.to_string(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  fn message(workspace_id: Uuid, event_id: Uuid, op: &str) -> CrossInstanceBroadcast {
    CrossInstanceBroadcast {
      origin_instance: Uuid::new_v4().to_string(),
      event: CALENDAR_EVENT_CHANGED.to_string(),
      workspace_id: workspace_id.to_string(),
      payload: json!({ "eventId": event_id, "op": op }),
      sender_socket_id: CALENDAR_REDIS_SENDER.to_string(),
    }
  }

  #[test]
  fn calendar_broadcast_validates_remote_event_without_origin_echo() {
    let workspace_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let remote_id = Uuid::new_v4();

    for op in ["created", "updated", "deleted"] {
      let event_id = Uuid::new_v4();
      let broadcast = CrossInstanceBroadcast {
        origin_instance: origin_id.to_string(),
        ..message(workspace_id, event_id, op)
      };

      assert!(
        !RedisWsAdapter::should_forward(origin_id, &broadcast),
        "origin node must suppress its Redis echo after local fanout"
      );
      assert!(
        RedisWsAdapter::should_forward(remote_id, &broadcast),
        "a second node must accept the same Calendar message"
      );
      assert_eq!(
        classify_redis_calendar_broadcast(&broadcast),
        CalendarRedisBroadcast::Event {
          workspace_id,
          event_id,
          op: op.to_string(),
        }
      );
    }
  }

  #[test]
  fn calendar_broadcast_rejects_malformed_remote_payloads() {
    let workspace_id = Uuid::new_v4();
    let event_id = Uuid::new_v4();

    let malformed = [
      CrossInstanceBroadcast {
        workspace_id: "not-a-workspace".to_string(),
        ..message(workspace_id, event_id, "created")
      },
      CrossInstanceBroadcast {
        payload: json!({ "eventId": "not-an-event", "op": "updated" }),
        ..message(workspace_id, event_id, "updated")
      },
      message(workspace_id, event_id, "upserted"),
      CrossInstanceBroadcast {
        payload: json!({ "eventId": event_id }),
        ..message(workspace_id, event_id, "deleted")
      },
    ];

    for broadcast in malformed {
      assert_eq!(
        classify_redis_calendar_broadcast(&broadcast),
        CalendarRedisBroadcast::Invalid,
        "malformed Calendar messages must be consumed before generic routing"
      );
    }

    let non_calendar = CrossInstanceBroadcast {
      event: "space:doc-delete".to_string(),
      ..message(workspace_id, event_id, "deleted")
    };
    assert_eq!(
      classify_redis_calendar_broadcast(&non_calendar),
      CalendarRedisBroadcast::NotCalendar
    );
  }
}
