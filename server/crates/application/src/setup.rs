// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server setup completion state.
//!
//! Setup completion is an operational lifecycle value stored alongside runtime
//! configuration, but it is deliberately absent from the configuration
//! registry. This service gives API transports one typed owner without making
//! the operational row a general configuration override.

use std::sync::RwLock;

use async_trait::async_trait;
use uuid::Uuid;

use crate::auth::AuthResult;

/// Durable transition produced by one setup-completion write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SetupCompletionChange {
  pub previous: Option<bool>,
  pub current: bool,
}

/// Persistence owner for the operational setup-completion row.
#[async_trait]
pub trait SetupStateStore: Send + Sync {
  /// Return `false` when setup has never been completed.
  async fn setup_completed(&self) -> AuthResult<bool>;

  /// Atomically replace setup completion and return its previous value.
  async fn set_setup_completed(&self, completed: bool, updated_by: Option<Uuid>) -> AuthResult<SetupCompletionChange>;
}

/// Application facade for setup lifecycle state.
#[derive(Clone)]
pub struct SetupStateService {
  store: std::sync::Arc<dyn SetupStateStore>,
}

impl SetupStateService {
  pub fn new(store: std::sync::Arc<dyn SetupStateStore>) -> Self {
    Self { store }
  }

  pub async fn setup_completed(&self) -> AuthResult<bool> {
    self.store.setup_completed().await
  }

  pub async fn set_setup_completed(
    &self,
    completed: bool,
    updated_by: Option<Uuid>,
  ) -> AuthResult<SetupCompletionChange> {
    self.store.set_setup_completed(completed, updated_by).await
  }
}

/// Deterministic setup-state store for API and application tests.
#[derive(Default)]
pub struct InMemorySetupStateStore {
  completed: RwLock<Option<bool>>,
}

#[async_trait]
impl SetupStateStore for InMemorySetupStateStore {
  async fn setup_completed(&self) -> AuthResult<bool> {
    Ok(
      self
        .completed
        .read()
        .expect("in-memory setup state lock poisoned")
        .unwrap_or(false),
    )
  }

  async fn set_setup_completed(&self, completed: bool, _updated_by: Option<Uuid>) -> AuthResult<SetupCompletionChange> {
    let mut state = self.completed.write().expect("in-memory setup state lock poisoned");
    let previous = state.replace(completed);
    Ok(SetupCompletionChange {
      previous,
      current: completed,
    })
  }
}
