// SPDX-License-Identifier: AGPL-3.0-or-later
//! Existing Redis adapters projected onto XWS cluster-coordination ports.

use async_trait::async_trait;
use myoxus_application::workspace_content_operation::coordination::{
  WORKSPACE_CONTENT_QUEUE, WORKSPACE_CONTENT_REALTIME_EVENT, WORKSPACE_CONTENT_RESUME_JOB,
  WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT, WorkspaceContentCacheInvalidationPort, WorkspaceContentCoordinationError,
  WorkspaceContentCoordinationResult, WorkspaceContentQueuePort, WorkspaceContentRealtimePort,
  WorkspaceContentRealtimeSignal, WorkspaceContentReconnectSignal,
};
use myoxus_application::workspace_content_operation::notification::WorkspaceContentNotificationFanoutPort;
use myoxus_domain::entities::Notification;
use myoxus_domain::ids::{WorkspaceContentOperationId, WorkspaceId};
use myoxus_worker::RedisQueue;
use myoxus_worker::job::JobOptions;
use tracing::warn;
use uuid::Uuid;

use crate::cache_bus::CacheInvalidationBus;
use crate::websocket::redis_adapter::RedisWsAdapter;

/// Queue adapter for operation-ID-only wake-ups.
///
/// The semantic job envelope and handler are owned by P-XWS-02-04. This
/// adapter deliberately serializes no content, permissions, or process ID.
pub struct RedisWorkspaceContentQueueAdapter {
  queue: RedisQueue,
}

impl RedisWorkspaceContentQueueAdapter {
  pub fn new(queue: RedisQueue) -> Self {
    Self { queue }
  }
}

#[async_trait]
impl WorkspaceContentQueuePort for RedisWorkspaceContentQueueAdapter {
  async fn wake(&self, operation_id: WorkspaceContentOperationId) -> WorkspaceContentCoordinationResult<()> {
    let job_id = operation_id.to_string();
    self
      .queue
      .enqueue_idempotent(
        WORKSPACE_CONTENT_QUEUE,
        &job_id,
        WORKSPACE_CONTENT_RESUME_JOB,
        serde_json::json!({ "operationId": operation_id }),
        JobOptions::default(),
      )
      .await
      .map(|_| ())
      .map_err(|error| {
        warn!(%operation_id, %error, "XWS queue wake-up failed");
        WorkspaceContentCoordinationError::unavailable("queue")
      })
  }

  async fn wake_git(&self, operation_id: WorkspaceContentOperationId) -> WorkspaceContentCoordinationResult<()> {
    self
      .queue
      .enqueue_idempotent(
        WORKSPACE_CONTENT_QUEUE,
        &format!("{operation_id}:git"),
        WORKSPACE_CONTENT_RESUME_JOB,
        serde_json::json!({ "operationId": operation_id }),
        JobOptions::default(),
      )
      .await
      .map(|_| ())
      .map_err(|error| {
        warn!(%operation_id, %error, "XWS Git metadata queue wake-up failed");
        WorkspaceContentCoordinationError::unavailable("queue")
      })
  }
}

#[async_trait]
impl WorkspaceContentCacheInvalidationPort for CacheInvalidationBus {
  async fn invalidate_workspace(&self, workspace_id: WorkspaceId) -> WorkspaceContentCoordinationResult<()> {
    self
      .try_publish("workspace_content", &workspace_id.to_string())
      .await
      .map(|_| ())
      .map_err(|error| {
        warn!(%workspace_id, %error, "XWS cache invalidation publish failed");
        WorkspaceContentCoordinationError::unavailable("cache")
      })
  }
}

#[async_trait]
impl WorkspaceContentRealtimePort for RedisWsAdapter {
  async fn publish(&self, signal: WorkspaceContentRealtimeSignal) -> WorkspaceContentCoordinationResult<()> {
    let payload = serde_json::json!({
      "operationId": signal.operation_id,
      "status": signal.status.as_str(),
    });
    self
      .try_broadcast_to_all_workspace_instances(
        &signal.workspace_id.to_string(),
        WORKSPACE_CONTENT_REALTIME_EVENT,
        &payload,
      )
      .await
      .map_err(|error| {
        warn!(
          operation_id = %signal.operation_id,
          workspace_id = %signal.workspace_id,
          %error,
          "XWS realtime publish failed"
        );
        WorkspaceContentCoordinationError::unavailable("realtime")
      })
  }

  async fn publish_reconnect(&self, signal: WorkspaceContentReconnectSignal) -> WorkspaceContentCoordinationResult<()> {
    let payload = serde_json::json!({
      "operationId": signal.operation_id,
      "resources": signal.resources,
    });
    self
      .try_broadcast_to_all_workspace_instances(
        &signal.workspace_id.to_string(),
        WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT,
        &payload,
      )
      .await
      .map_err(|error| {
        warn!(
          operation_id = %signal.operation_id,
          workspace_id = %signal.workspace_id,
          %error,
          "XWS sync coordination publish failed"
        );
        WorkspaceContentCoordinationError::unavailable("realtime")
      })
  }
}

#[async_trait]
impl WorkspaceContentNotificationFanoutPort for RedisWsAdapter {
  async fn publish(&self, recipient_id: Uuid, notification: &Notification) -> Result<(), &'static str> {
    self
      .try_publish_user_notification_to_all_instances(
        recipient_id, &notification.id.to_string(), "notification_new",
        &serde_json::json!({ "userId": recipient_id, "notificationId": notification.id, "notificationType": notification.notification_type }),
      )
      .await
      .map_err(|_| "redis_fanout")
  }
}
