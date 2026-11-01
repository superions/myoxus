// SPDX-License-Identifier: AGPL-3.0-or-later
//! Socket delivery adapter and wake-up coordination for persisted document updates.

use async_trait::async_trait;
use std::{
  collections::HashSet,
  sync::{Arc, Mutex, OnceLock},
};
use tracing::warn;
use uuid::Uuid;

use crate::ApiState;

pub use myoxus_application::events::WorkspaceDocumentBroadcastPublisher;

pub struct SocketWorkspaceDocumentBroadcastPublisher<'a> {
  state: &'a ApiState,
}

impl<'a> SocketWorkspaceDocumentBroadcastPublisher<'a> {
  pub const fn new(state: &'a ApiState) -> Self {
    Self { state }
  }
}

#[async_trait]
impl WorkspaceDocumentBroadcastPublisher for SocketWorkspaceDocumentBroadcastPublisher<'_> {
  async fn publish(&self, workspace_id: Uuid, document_key: &str, update: &[u8], editor: Uuid) -> Result<(), String> {
    crate::websocket::publish_persisted_workspace_doc_update(self.state, workspace_id, document_key, update, editor)
      .await
  }

  fn record_outcome(&self, outcome: &'static str) {
    self.state.metrics().record(
      myoxus_application::metrics::MetricsCategory::Collab,
      "workspace_doc_broadcast_total",
      &[("outcome", outcome)],
    );
  }
}

/// Schedule an immediate pass; the periodic loop remains the recovery owner.
pub fn wake_workspace_doc_broadcast_consumer(state: Arc<ApiState>) {
  static ACTIVE_WAKES: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();

  let Some(pool) = state.metrics_pool() else {
    warn!("document broadcast outbox wake-up skipped because the SQL pool is unavailable");
    return;
  };
  let state_key = Arc::as_ptr(&state) as usize;
  let active_wakes = ACTIVE_WAKES.get_or_init(|| Mutex::new(HashSet::new()));
  if !active_wakes
    .lock()
    .unwrap_or_else(|error| error.into_inner())
    .insert(state_key)
  {
    return;
  }
  tokio::spawn(async move {
    let publisher = SocketWorkspaceDocumentBroadcastPublisher::new(&state);
    if let Err(error) = process_workspace_doc_broadcast_batch(&pool, &publisher).await {
      warn!(%error, "immediate workspace document broadcast outbox pass failed");
    }
    ACTIVE_WAKES
      .get()
      .expect("wake registry is initialized before spawning")
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(&state_key);
  });
}

pub async fn process_workspace_doc_broadcast_batch(
  pool: &sqlx::PgPool,
  publisher: &dyn WorkspaceDocumentBroadcastPublisher,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  let repository = myoxus_infrastructure::outbox::SqlxOutboxRepository::new(pool.clone());
  for _ in 0..50 {
    if !repository.process_next_workspace_document_broadcast(publisher).await? {
      break;
    }
  }
  Ok(())
}

pub async fn process_next_workspace_doc_broadcast(
  pool: &sqlx::PgPool,
  publisher: &dyn WorkspaceDocumentBroadcastPublisher,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
  myoxus_infrastructure::outbox::SqlxOutboxRepository::new(pool.clone())
    .process_next_workspace_document_broadcast(publisher)
    .await
}
