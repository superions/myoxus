// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable recipient-outbox materialization for XWS notifications.

use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::Notification;
use myoxus_domain::ids::{UserId, WorkspaceContentOperationId};
use myoxus_domain::workspace_content_operation::WorkspaceContentResourceKind;
use serde_json::json;
use tracing::{instrument, warn};

use crate::auth::{AuthError, AuthResult};
use crate::notification::NotificationService;

pub const MAX_NOTIFICATION_DISPATCH_BATCH: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceContentNotificationIntent {
  pub id: i64,
  pub operation_id: WorkspaceContentOperationId,
  pub recipient_id: UserId,
  pub event_kind: String,
  pub source_workspace_id: uuid::Uuid,
  pub source_workspace_name: String,
  pub actor_id: UserId,
  pub published_at: DateTime<Utc>,
  pub resource_count: i32,
  pub visible_resource_kinds: Vec<WorkspaceContentResourceKind>,
}

#[async_trait]
pub trait WorkspaceContentNotificationOutboxPort: Send + Sync {
  async fn claim(&self, limit: usize) -> AuthResult<Vec<WorkspaceContentNotificationIntent>>;
  async fn mark_dispatched(&self, intent_id: i64) -> AuthResult<()>;
  async fn mark_failed(&self, intent_id: i64, reason: &'static str) -> AuthResult<()>;
}

#[async_trait]
pub trait WorkspaceContentNotificationFanoutPort: Send + Sync {
  async fn publish(&self, recipient_id: UserId, notification: &Notification) -> Result<(), &'static str>;
}

pub struct WorkspaceContentNotificationDispatcher {
  outbox: Arc<dyn WorkspaceContentNotificationOutboxPort>,
  notifications: Arc<NotificationService>,
  fanout: Arc<dyn WorkspaceContentNotificationFanoutPort>,
}

impl WorkspaceContentNotificationDispatcher {
  pub fn new(
    outbox: Arc<dyn WorkspaceContentNotificationOutboxPort>,
    notifications: Arc<NotificationService>,
    fanout: Arc<dyn WorkspaceContentNotificationFanoutPort>,
  ) -> Self {
    Self {
      outbox,
      notifications,
      fanout,
    }
  }

  /// Materialize one bounded batch. Persistence is exactly-once by the stable
  /// idempotency key; realtime remains retryable, best-effort acceleration.
  #[instrument(skip(self))]
  pub async fn dispatch(&self, limit: usize) -> AuthResult<usize> {
    if limit == 0 || limit > MAX_NOTIFICATION_DISPATCH_BATCH {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
      ));
    }
    let intents = self.outbox.claim(limit).await?;
    let mut dispatched = 0;
    for intent in intents {
      if intent.event_kind != "workspace_content_moved" {
        self.outbox.mark_failed(intent.id, "unsupported_event_kind").await?;
        continue;
      }
      let idempotency_key = format!("{}:{}:{}", intent.event_kind, intent.operation_id, intent.recipient_id);
      let notification = match self
        .notifications
        .create_in_app_notification(
          intent.recipient_id,
          intent.event_kind.clone(),
          None,
          idempotency_key,
          json!({
            "operationId": intent.operation_id,
            "sourceWorkspaceId": intent.source_workspace_id,
            "sourceWorkspaceName": intent.source_workspace_name,
            "actorId": intent.actor_id,
            "publishedAt": intent.published_at,
            "resourceCount": intent.resource_count,
            "resourceKinds": intent.visible_resource_kinds,
          }),
        )
        .await
      {
        Ok(notification) => notification,
        Err(error) => {
          super::diagnostics::record_operation_failure(intent.operation_id, None, "notification_persistence", &error);
          warn!(
            operation_id = %intent.operation_id,
            recipient_id = %intent.recipient_id,
            "XWS in-app notification persistence failed; durable intent remains retryable"
          );
          self.outbox.mark_failed(intent.id, "notification_persistence").await?;
          continue;
        }
      };
      if let Err(reason) = self.fanout.publish(intent.recipient_id, &notification).await {
        warn!(
          operation_id = %intent.operation_id,
          recipient_id = %intent.recipient_id,
          phase = "notification_fanout",
          cause = reason,
          "workspace_content.notification_fanout_failed"
        );
        self.outbox.mark_failed(intent.id, reason).await?;
        continue;
      }
      self.outbox.mark_dispatched(intent.id).await?;
      dispatched += 1;
    }
    Ok(dispatched)
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicBool, Ordering};

  use crate::notification::{InMemoryNotificationStore, NotificationListRequest};
  use uuid::Uuid;

  use super::*;

  struct RetryOutbox {
    intent: WorkspaceContentNotificationIntent,
    dispatched: AtomicBool,
    failures: Mutex<Vec<&'static str>>,
  }

  #[async_trait]
  impl WorkspaceContentNotificationOutboxPort for RetryOutbox {
    async fn claim(&self, _limit: usize) -> AuthResult<Vec<WorkspaceContentNotificationIntent>> {
      Ok(
        (!self.dispatched.load(Ordering::SeqCst))
          .then(|| self.intent.clone())
          .into_iter()
          .collect(),
      )
    }

    async fn mark_dispatched(&self, _intent_id: i64) -> AuthResult<()> {
      self.dispatched.store(true, Ordering::SeqCst);
      Ok(())
    }

    async fn mark_failed(&self, _intent_id: i64, reason: &'static str) -> AuthResult<()> {
      self.failures.lock().expect("failure lock").push(reason);
      Ok(())
    }
  }

  #[derive(Default)]
  struct FailOnceFanout {
    notification_ids: Mutex<Vec<Uuid>>,
  }

  #[async_trait]
  impl WorkspaceContentNotificationFanoutPort for FailOnceFanout {
    async fn publish(&self, _recipient_id: UserId, notification: &Notification) -> Result<(), &'static str> {
      let mut ids = self.notification_ids.lock().expect("fanout lock");
      ids.push(notification.id);
      if ids.len() == 1 { Err("redis_fanout") } else { Ok(()) }
    }
  }

  #[tokio::test]
  async fn retry_after_fanout_failure_reuses_the_persisted_notification() {
    let recipient_id = Uuid::new_v4();
    let operation_id = Uuid::new_v4();
    let outbox = Arc::new(RetryOutbox {
      intent: WorkspaceContentNotificationIntent {
        id: 1,
        operation_id,
        recipient_id,
        event_kind: "workspace_content_moved".to_string(),
        source_workspace_id: Uuid::new_v4(),
        source_workspace_name: "Source".to_string(),
        actor_id: Uuid::new_v4(),
        published_at: Utc::now(),
        resource_count: 2,
        visible_resource_kinds: vec![WorkspaceContentResourceKind::Document],
      },
      dispatched: AtomicBool::new(false),
      failures: Mutex::new(Vec::new()),
    });
    let notifications = Arc::new(NotificationService::new(Arc::new(InMemoryNotificationStore::default())));
    let fanout = Arc::new(FailOnceFanout::default());
    let dispatcher = WorkspaceContentNotificationDispatcher::new(outbox.clone(), notifications.clone(), fanout.clone());

    assert_eq!(dispatcher.dispatch(10).await.unwrap(), 0);
    assert_eq!(dispatcher.dispatch(10).await.unwrap(), 1);
    {
      let ids = fanout.notification_ids.lock().expect("fanout lock");
      assert_eq!(ids.len(), 2);
      assert_eq!(ids[0], ids[1], "fanout retry must reuse the idempotent row");
    }
    assert_eq!(
      outbox.failures.lock().expect("failure lock").as_slice(),
      &["redis_fanout"]
    );
    assert_eq!(
      notifications
        .list_notifications(
          recipient_id,
          NotificationListRequest {
            first: Some(10),
            ..Default::default()
          },
        )
        .await
        .unwrap()
        .total_count,
      1,
      "fanout retry must leave exactly one persistent Inbox notification"
    );
  }
}
