// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Database change-event notification port (P-DB-29B-C).
//
// Database mutation services call into this port after every successful Database
// mutation so subscribed WebSocket clients can refresh their view. The
// port is deliberately minimal — broadcast-only — so the application
// layer can never read presence state or per-client sockets. WebSocket
// routing, fan-out, room isolation and stale-timeout cleanup live behind
// the concrete adapter in `myoxus-api::websocket`.

use async_trait::async_trait;

use myoxus_domain::database_change::DatabaseChangeEvent;

use super::{PortError, PortResult};

/// Application-layer port for broadcasting Database change events to
/// subscribed WebSocket clients.
///
/// Implementations MUST:
///   * route the event to the room `database:{database_id}` only when
///     the caller has workspace access to `event.workspace_id`;
///   * never block the caller on slow subscribers;
///   * never panic on transport failure (return `Err(_)` instead);
///   * emit at most once per successful transaction; failed transactions
///     MUST NOT cause a `publish` call.
#[async_trait]
pub trait DatabaseChangeNotificationPort: Send + Sync {
  /// Publish `event` to all clients subscribed to the corresponding
  /// `database:{database_id}` room.
  async fn publish_change(&self, event: &DatabaseChangeEvent) -> PortResult<()>;

  /// Invalidate the workspace Task projection after commit. Delivery uses the
  /// authorized workspace room, with identities only and no Row/Cell data.
  async fn publish_tasks_changed(&self, _event: &DatabaseChangeEvent) -> PortResult<()> {
    Ok(())
  }
}

/// No-op [`DatabaseChangeNotificationPort`] for tests and single-instance
/// deployments that do not fan out Database changes to WebSocket
/// subscribers. Used by disabled test/runtime dependency bundles so that
/// no real WS adapter is required.
pub struct NullDatabaseChangeNotification;

#[async_trait]
impl DatabaseChangeNotificationPort for NullDatabaseChangeNotification {
  async fn publish_change(&self, _event: &DatabaseChangeEvent) -> PortResult<()> {
    Ok(())
  }
}

/// Convenience wrapper used by Database mutation services so callers can treat the
/// port as `Option<Arc<dyn ...>>` without sprinkling `Option` everywhere.
///
/// `publish_change` on `None` is a no-op.
#[async_trait]
impl<T: DatabaseChangeNotificationPort> DatabaseChangeNotificationPort for Option<T> {
  async fn publish_tasks_changed(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    match self {
      Some(inner) => inner.publish_tasks_changed(event).await,
      None => Ok(()),
    }
  }

  async fn publish_change(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    match self {
      Some(inner) => inner.publish_change(event).await,
      None => Ok(()),
    }
  }
}

#[async_trait]
impl<T: DatabaseChangeNotificationPort + ?Sized> DatabaseChangeNotificationPort for std::sync::Arc<T> {
  async fn publish_tasks_changed(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    (**self).publish_tasks_changed(event).await
  }

  async fn publish_change(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    (**self).publish_change(event).await
  }
}

/// Helper that translates a broadcast error into a structured warning so
/// Database mutation callers can decide whether to surface the failure to
/// the caller or simply log it.
pub fn classify_publish_error(err: &PortError) -> &'static str {
  match err {
    PortError::InvalidInput(_) => "invalid_input",
    PortError::NotFound(_) => "no_subscribers",
    PortError::Conflict(_) => "conflict",
    PortError::Transport(_) => "transport_failure",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use myoxus_domain::database_change::{DatabaseChangeEvent, DatabaseChangeKind};
  use myoxus_domain::ids::WorkspaceId;
  use uuid::Uuid;

  #[tokio::test]
  async fn null_port_silently_accepts_publish() {
    let port = NullDatabaseChangeNotification;
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      Uuid::new_v4(),
      DatabaseChangeKind::CellUpdated,
      Uuid::new_v4(),
    );
    assert!(port.publish_change(&event).await.is_ok());
  }

  #[tokio::test]
  async fn option_none_is_no_op() {
    let port: Option<NullDatabaseChangeNotification> = None;
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      Uuid::new_v4(),
      DatabaseChangeKind::RowCreated,
      Uuid::new_v4(),
    );
    assert!(port.publish_change(&event).await.is_ok());
  }

  #[tokio::test]
  async fn option_some_delegates_to_inner() {
    let port: Option<NullDatabaseChangeNotification> = Some(NullDatabaseChangeNotification);
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      Uuid::new_v4(),
      DatabaseChangeKind::RowUpdated,
      Uuid::new_v4(),
    );
    assert!(port.publish_change(&event).await.is_ok());
  }

  #[test]
  fn classify_returns_stable_label() {
    let transport = PortError::Transport("socket closed".into());
    assert_eq!(classify_publish_error(&transport), "transport_failure");
  }

  #[test]
  fn empty_target_event_is_acceptable() {
    let event = DatabaseChangeEvent::new(
      WorkspaceId::new_v4(),
      Uuid::new_v4(),
      DatabaseChangeKind::BulkImported,
      Uuid::new_v4(),
    );
    // No row/field/view target — broadcast-only fan-out is allowed.
    let _ = event.committed_at.timestamp_millis() - Utc::now().timestamp_millis();
  }
}
