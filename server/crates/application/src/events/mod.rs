//! Domain event publishing port.
//!
//! The transactional outbox pattern is implemented by writing events to the
//! `outbox_events` table alongside the business transaction that triggers them.
//! [`EventPublisher`] abstracts this operation so that application services do
//! not depend on the concrete outbox repository.
//!
//! [`NoopEventPublisher`] is provided for use in tests and contexts where event
//! propagation is not required.

use async_trait::async_trait;
use serde_json::Value;
use tracing::instrument;
use uuid::Uuid;

/// Ephemeral committed-workspace wakeups, not another event ledger. Bounded
/// loss/duplicates are repaired by the resource observer's shared heartbeat.
#[derive(Clone, Debug)]
pub struct WorkspaceResourceUpdates {
  sender: tokio::sync::broadcast::Sender<Uuid>,
}

impl Default for WorkspaceResourceUpdates {
  fn default() -> Self {
    let (sender, _) = tokio::sync::broadcast::channel(128);
    Self { sender }
  }
}

impl WorkspaceResourceUpdates {
  pub fn wake(&self, workspace: Uuid) {
    // No consumer is normal; resource reads remain entirely persistence-backed.
    let _ = self.sender.send(workspace);
  }

  pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Uuid> {
    self.sender.subscribe()
  }
}

use crate::auth::AuthResult;
use myoxus_domain::entities::OutboxEventType;

/// Port for appending domain events to the transactional outbox.
#[async_trait]
pub trait EventPublisher: Send + Sync {
  /// Append an event to the outbox.
  ///
  /// - `aggregate_type` — string identifier for the entity kind (e.g.
  ///   `"workspace"`, `"user"`).
  /// - `aggregate_id` — the entity's ID as a string.
  /// - `event_type` — the specific event that occurred.
  /// - `payload` — arbitrary JSON data carried by the event.
  async fn publish(
    &self,
    aggregate_type: &str,
    aggregate_id: &str,
    event_type: OutboxEventType,
    payload: Value,
  ) -> AuthResult<()>;
}

/// Delivery target for one persisted workspace-document update.
///
/// The PostgreSQL outbox adapter owns the row lock and invokes this port while
/// that lock is held, preserving the existing at-least-once delivery contract.
#[async_trait]
pub trait WorkspaceDocumentBroadcastPublisher: Send + Sync {
  async fn publish(&self, workspace_id: Uuid, document_key: &str, update: &[u8], editor: Uuid) -> Result<(), String>;

  fn record_outcome(&self, _outcome: &'static str) {}
}

/// Search delivery for a committed native page change. The SQL outbox retains
/// its claim until enqueue succeeds; implementations must tolerate replay.
#[async_trait]
pub trait DocumentSearchUpdatePublisher: Send + Sync {
  async fn enqueue_search_update(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()>;
}

/// A no-op event publisher that silently discards every event.
///
/// Used in tests and in contexts where event propagation is not needed (e.g.
/// admin-seeding scripts).
#[derive(Default)]
pub struct NoopEventPublisher;

#[async_trait]
impl EventPublisher for NoopEventPublisher {
  #[instrument(skip(self, _payload))]
  async fn publish(
    &self,
    _aggregate_type: &str,
    _aggregate_id: &str,
    _event_type: OutboxEventType,
    _payload: Value,
  ) -> AuthResult<()> {
    Ok(())
  }
}
