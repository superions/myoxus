// SPDX-License-Identifier: AGPL-3.0-or-later
//! Cluster coordination ports for cross-workspace content operations.
//!
//! PostgreSQL remains the operation and recovery authority. Redis transports
//! wake-ups, cache invalidations, and realtime hints, but none of those signals
//! may replace durable state or permit a process-local fallback.

use std::sync::Arc;

use async_trait::async_trait;
use myoxus_domain::ids::{WorkspaceContentOperationId, WorkspaceId};
use myoxus_domain::workspace_content_operation::{WorkspaceContentOperationStatus, WorkspaceContentResourceRef};
use thiserror::Error;

use super::WorkspaceContentOperationRepository;

pub const WORKSPACE_CONTENT_QUEUE: &str = "workspace-content-operation";
pub const WORKSPACE_CONTENT_RESUME_JOB: &str = "workspaceContentOperation.resume";
pub const WORKSPACE_CONTENT_REALTIME_EVENT: &str = "workspace:content-operation-updated";
pub const WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT: &str = "workspace:content-operation-reconnect";
pub const MAX_RECONCILE_BATCH_SIZE: usize = 1_000;

/// Internal transport failure. It is retryable infrastructure state, not an
/// operation blocker or a public product error.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("workspace content coordination dependency unavailable: {dependency}")]
pub struct WorkspaceContentCoordinationError {
  dependency: &'static str,
}

impl WorkspaceContentCoordinationError {
  pub const fn unavailable(dependency: &'static str) -> Self {
    Self { dependency }
  }

  pub const fn dependency(&self) -> &'static str {
    self.dependency
  }
}

pub type WorkspaceContentCoordinationResult<T> = Result<T, WorkspaceContentCoordinationError>;

/// Redis-backed wake-up transport. The payload contains only the durable
/// operation identity; workers reload all semantics from PostgreSQL.
#[async_trait]
pub trait WorkspaceContentQueuePort: Send + Sync {
  async fn wake(&self, operation_id: WorkspaceContentOperationId) -> WorkspaceContentCoordinationResult<()>;
  /// A distinct job identity prevents a completed content job from swallowing
  /// the metadata wake-up; the payload stays operation-ID-only.
  async fn wake_git(&self, operation_id: WorkspaceContentOperationId) -> WorkspaceContentCoordinationResult<()>;
}

/// Cross-instance invalidation of process-local workspace projections.
#[async_trait]
pub trait WorkspaceContentCacheInvalidationPort: Send + Sync {
  async fn invalidate_workspace(&self, workspace_id: WorkspaceId) -> WorkspaceContentCoordinationResult<()>;
}

/// Content-free realtime status hint. Clients recover from the durable status
/// query when this best-effort delivery is missed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceContentRealtimeSignal {
  pub workspace_id: WorkspaceId,
  pub operation_id: WorkspaceContentOperationId,
  pub status: WorkspaceContentOperationStatus,
}

/// Resource-qualified collaboration refresh after committed publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentReconnectSignal {
  pub workspace_id: WorkspaceId,
  pub operation_id: WorkspaceContentOperationId,
  pub resources: Vec<WorkspaceContentResourceRef>,
}

#[async_trait]
pub trait WorkspaceContentRealtimePort: Send + Sync {
  async fn publish(&self, signal: WorkspaceContentRealtimeSignal) -> WorkspaceContentCoordinationResult<()>;
  async fn publish_reconnect(&self, signal: WorkspaceContentReconnectSignal) -> WorkspaceContentCoordinationResult<()>;
}

/// Application-owned coordination boundary.
///
/// Reconcile derives queue wake-ups from SQL, while committed outbox events
/// own cache and realtime fanout. Transport availability never becomes
/// semantic operation state.
pub struct WorkspaceContentClusterCoordinator {
  repository: Arc<dyn WorkspaceContentOperationRepository>,
  queue: Arc<dyn WorkspaceContentQueuePort>,
  cache: Option<Arc<dyn WorkspaceContentCacheInvalidationPort>>,
  realtime: Option<Arc<dyn WorkspaceContentRealtimePort>>,
}

impl WorkspaceContentClusterCoordinator {
  pub fn new(
    repository: Arc<dyn WorkspaceContentOperationRepository>,
    queue: Arc<dyn WorkspaceContentQueuePort>,
    cache: Option<Arc<dyn WorkspaceContentCacheInvalidationPort>>,
    realtime: Option<Arc<dyn WorkspaceContentRealtimePort>>,
  ) -> Self {
    Self {
      repository,
      queue,
      cache,
      realtime,
    }
  }

  /// Emit one best-effort wake-up for a durable queued operation.
  pub async fn wake_operation(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> WorkspaceContentCoordinationResult<()> {
    self.queue.wake(operation_id).await
  }

  pub async fn wake_git_operation(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> WorkspaceContentCoordinationResult<()> {
    self.queue.wake_git(operation_id).await
  }

  /// Re-emit lost wake-ups from the authoritative SQL operation state.
  pub async fn reconcile(&self, limit: usize) -> WorkspaceContentCoordinationResult<usize> {
    if limit == 0 || limit > MAX_RECONCILE_BATCH_SIZE {
      return Err(WorkspaceContentCoordinationError::unavailable("operation_store"));
    }
    let operation_ids = self
      .repository
      .list_reconcilable_operation_ids(limit)
      .await
      .map_err(|_| WorkspaceContentCoordinationError::unavailable("operation_store"))?;
    for operation_id in &operation_ids {
      let git_pending = self
        .repository
        .has_reconcilable_git_work(*operation_id)
        .await
        .map_err(|_| WorkspaceContentCoordinationError::unavailable("operation_store"))?;
      if git_pending {
        self.queue.wake_git(*operation_id).await?;
      } else {
        self.queue.wake(*operation_id).await?;
      }
    }
    Ok(operation_ids.len())
  }

  /// Publish invalidation before the realtime hint.
  ///
  /// Local cache/session fast paths may run only after this method succeeds.
  /// Partial publication remains recoverable from SQL and idempotent workers.
  pub async fn publish_change(&self, signal: WorkspaceContentRealtimeSignal) -> WorkspaceContentCoordinationResult<()> {
    self
      .cache
      .as_ref()
      .ok_or_else(|| WorkspaceContentCoordinationError::unavailable("cache"))?
      .invalidate_workspace(signal.workspace_id)
      .await?;
    self
      .realtime
      .as_ref()
      .ok_or_else(|| WorkspaceContentCoordinationError::unavailable("realtime"))?
      .publish(signal)
      .await
  }

  /// Fan out one already committed publication from its transactional outbox.
  ///
  /// The durable outbox owns reconnect delivery after a crash: all affected
  /// collaboration documents receive a reconnect hint before the operation
  /// status hint is acknowledged.
  pub async fn publish_committed_change(
    &self,
    signal: WorkspaceContentRealtimeSignal,
    resources: Vec<WorkspaceContentResourceRef>,
  ) -> WorkspaceContentCoordinationResult<()> {
    let realtime = self
      .realtime
      .as_ref()
      .ok_or_else(|| WorkspaceContentCoordinationError::unavailable("realtime"))?;
    let mut by_workspace = std::collections::BTreeMap::<WorkspaceId, Vec<WorkspaceContentResourceRef>>::new();
    for resource in resources {
      by_workspace.entry(resource.workspace_id()).or_default().push(resource);
    }
    for (workspace_id, mut resources) in by_workspace {
      resources.sort();
      resources.dedup();
      realtime
        .publish_reconnect(WorkspaceContentReconnectSignal {
          workspace_id,
          operation_id: signal.operation_id,
          resources,
        })
        .await?;
    }
    self.publish_change(signal).await
  }
}
