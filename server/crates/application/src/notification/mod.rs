//! Notification service, its storage port, and supporting types.
//!
//! [`NotificationService`] creates in-app notifications and optionally
//! dispatches notification emails via [`crate::ports::MailPort`].
//! Pagination uses a base64-encoded cursor (`created_at|id`) that is stable
//! across concurrent inserts.

pub mod document_change;
pub mod mail;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{instrument, warn};
use uuid::Uuid;

use self::mail::NotificationMailProjector;
use crate::auth::{AuthError, AuthResult, EffectiveUserPreferences};
use crate::ports::MailPort;
use myoxus_domain::entities::Notification;

/// An opaque pagination cursor encoding a (created_at, id) pair.
///
/// The cursor is base64url-encoded to make it safe to embed in GraphQL
/// arguments without additional escaping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationCursor {
  /// Timestamp of the notification at this cursor position.
  pub created_at: DateTime<Utc>,
  /// Notification ID for tie-breaking within the same millisecond.
  pub id: Uuid,
}

impl NotificationCursor {
  /// Encode this cursor to a base64url string suitable for external clients.
  pub fn encode(&self) -> String {
    let raw = format!("{}|{}", self.created_at.to_rfc3339(), self.id);
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
  }

  /// Decode and validate a cursor string previously produced by [`encode`](Self::encode).
  pub fn decode(cursor: &str) -> AuthResult<Self> {
    let raw = URL_SAFE_NO_PAD
      .decode(cursor)
      .map_err(|e| AuthError::InvalidInput(format!("invalid notification cursor: {e}")))?;
    let decoded = String::from_utf8(raw)
      .map_err(|e| AuthError::InvalidInput(format!("invalid notification cursor encoding: {e}")))?;
    let mut parts = decoded.split('|');
    let created_at = parts
      .next()
      .ok_or_else(|| AuthError::InvalidInput("invalid notification cursor payload".to_string()))
      .and_then(|value| {
        DateTime::parse_from_rfc3339(value)
          .map(|dt| dt.with_timezone(&Utc))
          .map_err(|e| AuthError::InvalidInput(format!("invalid notification cursor timestamp: {e}")))
      })?;
    let id = parts
      .next()
      .ok_or_else(|| AuthError::InvalidInput("invalid notification cursor payload".to_string()))
      .and_then(|value| {
        Uuid::parse_str(value).map_err(|e| AuthError::InvalidInput(format!("invalid notification cursor id: {e}")))
      })?;
    if parts.next().is_some() {
      return Err(AuthError::InvalidInput(
        "invalid notification cursor payload".to_string(),
      ));
    }
    Ok(Self { created_at, id })
  }
}

/// GraphQL-style request parameters for listing notifications.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotificationListRequest {
  /// Maximum number of results to return (clamped to 1–100, default 20).
  pub first: Option<i64>,
  /// Number of rows to skip (for non-cursor-based pagination).
  pub offset: Option<i64>,
  /// Opaque cursor from a previous response; results are returned after this
  /// position.
  pub after: Option<String>,
  /// Include already-read notifications in the results.
  pub include_read: Option<bool>,
  /// Restrict results to these storage-level notification types. `None`
  /// selects all types; an empty list is invalid.
  pub notification_types: Option<Vec<String>>,
}

/// Normalised filters shared by notification list and count operations.
///
/// Keeping pagination out of this value makes it impossible for list and count
/// to silently apply different read/type scopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationListFilter {
  /// Whether already-read notifications participate in the result set.
  pub include_read: bool,
  /// Sorted, deduplicated storage-level types, or `None` for all types.
  pub notification_types: Option<Vec<String>>,
}

impl NotificationListFilter {
  fn matches(&self, notification: &Notification) -> bool {
    (self.include_read || notification.read_at.is_none())
      && self
        .notification_types
        .as_ref()
        .is_none_or(|types| types.iter().any(|value| value == &notification.notification_type))
  }
}

/// Normalised query sent to [`NotificationStore::list_notifications`].
#[derive(Debug, Clone)]
pub struct NotificationListQuery {
  /// Number of rows to fetch (always `first + 1` to detect `has_next_page`).
  pub fetch_limit: i64,
  /// Rows to skip before returning results.
  pub offset: i64,
  /// Read/type scope used identically by list and count.
  pub filter: NotificationListFilter,
  /// Decoded cursor for keyset pagination.
  pub after: Option<NotificationCursor>,
}

/// A single notification node together with its pagination cursor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationEdge {
  /// Cursor string for this node (can be passed as `after` in the next
  /// request).
  pub cursor: String,
  /// The notification data.
  pub node: Notification,
}

/// Relay-style page info returned alongside a notification list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationPageInfo {
  /// Cursor of the first edge in this page.
  pub start_cursor: Option<String>,
  /// Cursor of the last edge in this page.
  pub end_cursor: Option<String>,
  /// Whether there are more results after this page.
  pub has_next_page: bool,
  /// Whether there were results before this page.
  pub has_previous_page: bool,
}

/// A Relay-style paginated notification list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConnection {
  /// Total number of notifications matching the filter (before pagination).
  pub total_count: i64,
  /// The notifications on this page.
  pub edges: Vec<NotificationEdge>,
  /// Pagination metadata.
  pub page_info: NotificationPageInfo,
}

/// Storage distinguishes a new row from a replay so delivery cannot be retriggered.
#[derive(Debug, Clone)]
pub struct NotificationCreateOutcome {
  pub notification: Notification,
  pub inserted: bool,
}

/// Account notification-email policy. Transactional mail does not use this policy.
#[derive(Debug, Clone, Copy)]
pub enum NotificationEmailCategory {
  Invitation,
  Mention,
  Comment,
  Other,
}

impl NotificationEmailCategory {
  pub fn from_notification_type(kind: &str) -> Self {
    match kind {
      "invite"
      | "invitation"
      | "workspace_invitation"
      | "invitation_accepted"
      | "invitation_review_request"
      | "invitation_review_approved"
      | "invitation_review_declined" => Self::Invitation,
      "mention" | "doc_mention" | "document_mention" | "comment_mention" => Self::Mention,
      "comment" | "comment_reply" => Self::Comment,
      _ => Self::Other,
    }
  }

  pub fn enabled(self, preferences: &EffectiveUserPreferences) -> bool {
    match self {
      Self::Invitation => preferences.receive_invitation_email,
      Self::Mention => preferences.receive_mention_email,
      Self::Comment => preferences.receive_comment_email,
      Self::Other => true,
    }
  }
}

/// Persistence port for user notifications.
#[async_trait]
pub trait NotificationStore: Send + Sync {
  /// Create a new notification.  `idempotency_key` prevents duplicate rows
  /// for the same logical event.
  async fn create_notification(
    &self,
    user_id: Uuid,
    notification_type: String,
    notification_level: String,
    idempotency_key: Option<String>,
    payload: Value,
    now: DateTime<Utc>,
  ) -> AuthResult<NotificationCreateOutcome>;
  /// Return a page of notifications for the given user.
  async fn list_notifications(&self, user_id: Uuid, query: NotificationListQuery) -> AuthResult<Vec<Notification>>;
  /// Return the total number of notifications matching the supplied filter.
  async fn count_notifications(&self, user_id: Uuid, filter: &NotificationListFilter) -> AuthResult<i64>;
  /// Mark a single notification as read.  Returns `false` if not found.
  async fn mark_notification_read(
    &self,
    user_id: Uuid,
    notification_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<bool>;
  /// Mark all unread notifications for a user as read.  Returns the number of
  /// rows updated.
  async fn mark_all_notifications_read(&self, user_id: Uuid, read_at: DateTime<Utc>) -> AuthResult<i64>;
}

/// Service for creating and querying user notifications.
///
/// When `notification_emails_enabled` is `true` and a
/// [`MailPort`] and projector are configured, a best-effort notification email
/// is dispatched only after a newly inserted row; failures are
/// logged as warnings rather than propagated.
#[derive(Clone)]
pub struct NotificationService {
  store: Arc<dyn NotificationStore>,
  mail: Option<(Arc<dyn MailPort>, NotificationMailProjector)>,
  notification_emails_enabled: bool,
}

impl NotificationService {
  /// Create a `NotificationService` without email dispatch.
  pub fn new(store: Arc<dyn NotificationStore>) -> Self {
    Self {
      store,
      mail: None,
      notification_emails_enabled: false,
    }
  }

  /// Configure notification mail using the shared sender and live-state projector.
  /// Startup disables dispatch when no SMTP endpoint is configured.
  pub fn new_with_email(
    store: Arc<dyn NotificationStore>,
    mailer: Arc<dyn MailPort>,
    projector: NotificationMailProjector,
    notification_emails_enabled: bool,
  ) -> Self {
    Self {
      store,
      mail: Some((mailer, projector)),
      notification_emails_enabled,
    }
  }

  fn normalize_list_request(request: NotificationListRequest) -> AuthResult<(i64, NotificationListQuery)> {
    let first = request.first.unwrap_or(20).clamp(1, 100);
    let offset = request.offset.unwrap_or(0).max(0);
    let notification_types = request
      .notification_types
      .map(|types| {
        if types.is_empty() {
          return Err(AuthError::InvalidInput(
            "notification type filter must contain at least one type".to_string(),
          ));
        }
        Ok(types.into_iter().collect::<BTreeSet<_>>().into_iter().collect())
      })
      .transpose()?;
    let after = request.after.as_deref().map(NotificationCursor::decode).transpose()?;
    Ok((
      first,
      NotificationListQuery {
        fetch_limit: first + 1,
        offset,
        filter: NotificationListFilter {
          include_read: request.include_read.unwrap_or(false),
          notification_types,
        },
        after,
      },
    ))
  }

  /// Create a notification and optionally send a notification email.
  #[instrument(skip(self, payload))]
  pub async fn create_notification(
    &self,
    user_id: Uuid,
    notification_type: String,
    notification_level: Option<String>,
    idempotency_key: Option<String>,
    payload: Value,
  ) -> AuthResult<Notification> {
    let notification = self
      .store
      .create_notification(
        user_id,
        notification_type,
        notification_level.unwrap_or_else(|| "default".to_string()),
        idempotency_key,
        payload,
        Utc::now(),
      )
      .await?;
    if notification.inserted {
      self
        .dispatch_notification_email(
          notification.notification.user_id,
          &notification.notification.notification_type,
          &notification.notification.payload,
        )
        .await;
    }
    Ok(notification.notification)
  }

  /// Best-effort delivery also used by deployed pending comment-mention mail jobs.
  /// Preference lookup and SMTP failure never undo an already persisted Inbox row.
  pub async fn dispatch_notification_email(&self, user_id: Uuid, notification_type: &str, payload: &Value) {
    if !self.notification_emails_enabled {
      return;
    }
    if let Some((mailer, projector)) = &self.mail {
      let result = async {
        if let Some(mail) = projector.prepare(user_id, notification_type, payload).await? {
          mailer
            .send_template(mail)
            .await
            .map_err(|_| AuthError::Storage("Notification mail delivery failed".into()))?;
        }
        Ok::<(), AuthError>(())
      }
      .await;
      if let Err(error) = result {
        warn!(user_id = %user_id, notification_type = %notification_type,
          error = %error, "notification email dispatch failed");
      }
    }
  }

  /// Persist an in-app-only notification through the canonical idempotency
  /// path. This method deliberately bypasses email configuration; callers such
  /// as durable operation outboxes must never create an implicit mail side
  /// effect.
  #[instrument(skip(self, payload))]
  pub async fn create_in_app_notification(
    &self,
    user_id: Uuid,
    notification_type: String,
    notification_level: Option<String>,
    idempotency_key: String,
    payload: Value,
  ) -> AuthResult<Notification> {
    self
      .store
      .create_notification(
        user_id,
        notification_type,
        notification_level.unwrap_or_else(|| "default".to_string()),
        Some(idempotency_key),
        payload,
        Utc::now(),
      )
      .await
      .map(|outcome| outcome.notification)
  }

  /// Return a Relay-style paginated list of notifications for a user.
  #[instrument(skip(self))]
  pub async fn list_notifications(
    &self,
    user_id: Uuid,
    request: NotificationListRequest,
  ) -> AuthResult<NotificationConnection> {
    let (first, query) = Self::normalize_list_request(request)?;
    let total_count = self.store.count_notifications(user_id, &query.filter).await?;

    let has_previous_page = query.after.is_some() || query.offset > 0;
    let mut rows = self.store.list_notifications(user_id, query).await?;
    let has_next_page = (rows.len() as i64) > first;
    if has_next_page {
      rows.truncate(first as usize);
    }
    let edges: Vec<NotificationEdge> = rows
      .into_iter()
      .map(|node| NotificationEdge {
        cursor: NotificationCursor {
          created_at: node.created_at,
          id: node.id,
        }
        .encode(),
        node,
      })
      .collect();
    let start_cursor = edges.first().map(|edge| edge.cursor.clone());
    let end_cursor = edges.last().map(|edge| edge.cursor.clone());

    Ok(NotificationConnection {
      total_count,
      edges,
      page_info: NotificationPageInfo {
        start_cursor,
        end_cursor,
        has_next_page,
        has_previous_page,
      },
    })
  }

  /// Return the number of unread notifications for a user.
  #[instrument(skip(self))]
  pub async fn unread_count(&self, user_id: Uuid) -> AuthResult<i64> {
    self
      .store
      .count_notifications(
        user_id,
        &NotificationListFilter {
          include_read: false,
          notification_types: None,
        },
      )
      .await
  }

  /// Mark a single notification as read.  Returns `false` if not found.
  #[instrument(skip(self))]
  pub async fn mark_notification_read(&self, user_id: Uuid, notification_id: Uuid) -> AuthResult<bool> {
    let changed = self
      .store
      .mark_notification_read(user_id, notification_id, Utc::now())
      .await?;
    if !changed {
      warn!(%user_id, %notification_id, "notification read request did not match any row");
    }
    Ok(changed)
  }

  /// Mark all unread notifications as read.  Returns the count of rows changed.
  #[instrument(skip(self))]
  pub async fn mark_all_notifications_read(&self, user_id: Uuid) -> AuthResult<i64> {
    self.store.mark_all_notifications_read(user_id, Utc::now()).await
  }
}

/// In-memory [`NotificationStore`] for use in tests.
#[derive(Default)]
pub struct InMemoryNotificationStore {
  rows: Mutex<Vec<Notification>>,
}

#[async_trait]
impl NotificationStore for InMemoryNotificationStore {
  async fn create_notification(
    &self,
    user_id: Uuid,
    notification_type: String,
    notification_level: String,
    idempotency_key: Option<String>,
    payload: Value,
    now: DateTime<Utc>,
  ) -> AuthResult<NotificationCreateOutcome> {
    let mut rows = self
      .rows
      .lock()
      .map_err(|_| AuthError::Storage("in-memory notification store lock poisoned".to_string()))?;
    if let Some(key) = idempotency_key.as_deref()
      && let Some(existing) = rows
        .iter()
        .find(|row| row.idempotency_key.as_deref() == Some(key))
        .cloned()
    {
      return Ok(NotificationCreateOutcome {
        notification: existing,
        inserted: false,
      });
    }
    let notification = Notification {
      id: Uuid::new_v4(),
      user_id,
      notification_type,
      notification_level,
      idempotency_key,
      payload,
      read_at: None,
      created_at: now,
      updated_at: now,
    };
    rows.push(notification.clone());
    Ok(NotificationCreateOutcome {
      notification,
      inserted: true,
    })
  }

  async fn list_notifications(&self, user_id: Uuid, query: NotificationListQuery) -> AuthResult<Vec<Notification>> {
    let rows = self
      .rows
      .lock()
      .map_err(|_| AuthError::Storage("in-memory notification store lock poisoned".to_string()))?;
    let mut filtered: Vec<Notification> = rows
      .iter()
      .filter(|row| row.user_id == user_id)
      .filter(|row| query.filter.matches(row))
      .filter(|row| match query.after.as_ref() {
        Some(after) => (row.created_at, row.id) < (after.created_at, after.id),
        None => true,
      })
      .cloned()
      .collect();
    filtered.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    let start = query.offset as usize;
    let end = (start + query.fetch_limit as usize).min(filtered.len());
    if start >= filtered.len() {
      return Ok(Vec::new());
    }
    Ok(filtered[start..end].to_vec())
  }

  async fn count_notifications(&self, user_id: Uuid, filter: &NotificationListFilter) -> AuthResult<i64> {
    let rows = self
      .rows
      .lock()
      .map_err(|_| AuthError::Storage("in-memory notification store lock poisoned".to_string()))?;
    Ok(
      rows
        .iter()
        .filter(|row| row.user_id == user_id)
        .filter(|row| filter.matches(row))
        .count() as i64,
    )
  }

  async fn mark_notification_read(
    &self,
    user_id: Uuid,
    notification_id: Uuid,
    read_at: DateTime<Utc>,
  ) -> AuthResult<bool> {
    let mut rows = self
      .rows
      .lock()
      .map_err(|_| AuthError::Storage("in-memory notification store lock poisoned".to_string()))?;
    let Some(row) = rows
      .iter_mut()
      .find(|row| row.user_id == user_id && row.id == notification_id)
    else {
      return Ok(false);
    };
    if row.read_at.is_none() {
      row.read_at = Some(read_at);
      row.updated_at = read_at;
    }
    Ok(true)
  }

  async fn mark_all_notifications_read(&self, user_id: Uuid, read_at: DateTime<Utc>) -> AuthResult<i64> {
    let mut rows = self
      .rows
      .lock()
      .map_err(|_| AuthError::Storage("in-memory notification store lock poisoned".to_string()))?;
    let mut affected = 0i64;
    for row in rows
      .iter_mut()
      .filter(|row| row.user_id == user_id && row.read_at.is_none())
    {
      row.read_at = Some(read_at);
      row.updated_at = read_at;
      affected += 1;
    }
    Ok(affected)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};

  struct CountingMailPort {
    calls: AtomicUsize,
    fail: bool,
  }

  #[async_trait]
  impl MailPort for CountingMailPort {
    async fn send_template(&self, _mail: crate::ports::TemplateMail) -> crate::ports::PortResult<()> {
      self.calls.fetch_add(1, Ordering::SeqCst);
      if self.fail {
        Err(crate::ports::PortError::Transport("mail unavailable".to_string()))
      } else {
        Ok(())
      }
    }
  }

  fn test_projector(user_id: Uuid) -> NotificationMailProjector {
    let auth = Arc::new(crate::auth::InMemoryAuthStore::default());
    auth.insert_user(crate::auth::AuthUser {
      id: user_id,
      email: "recipient@example.test".into(),
      name: None,
      avatar_url: None,
      password_hash: None,
      is_admin: false,
      disabled: false,
      email_verified_at: Some(Utc::now()),
      registered: true,
    });
    NotificationMailProjector::new(auth)
  }

  #[tokio::test]
  async fn notification_email_enablement_and_failure_remain_best_effort() {
    for (enabled, fail, expected_calls) in [(false, false, 0), (true, false, 1), (true, true, 1)] {
      let email = Arc::new(CountingMailPort {
        calls: AtomicUsize::new(0),
        fail,
      });
      let user_id = Uuid::new_v4();
      let service = NotificationService::new_with_email(
        Arc::new(InMemoryNotificationStore::default()),
        email.clone(),
        test_projector(user_id),
        enabled,
      );
      let result = service
        .create_notification(
          user_id,
          "general".to_string(),
          Some("default".to_string()),
          Some(Uuid::new_v4().to_string()),
          serde_json::json!({ "rowTitle": "Release" }),
        )
        .await;
      assert!(result.is_ok(), "mail failure must not fail notification persistence");
      assert_eq!(email.calls.load(Ordering::SeqCst), expected_calls);
    }

    let store = Arc::new(InMemoryNotificationStore::default());
    let email = Arc::new(CountingMailPort {
      calls: AtomicUsize::new(0),
      fail: false,
    });
    let user_id = Uuid::new_v4();
    let service = NotificationService::new_with_email(store, email.clone(), test_projector(user_id), true);
    let idempotency_key = format!("workspace_content_moved:{}:{user_id}", Uuid::new_v4());
    let first = service
      .create_in_app_notification(
        user_id,
        "workspace_content_moved".to_string(),
        None,
        idempotency_key.clone(),
        serde_json::json!({ "resourceCount": 1 }),
      )
      .await
      .expect("persist in-app-only XWS notification");
    let replay = service
      .create_in_app_notification(
        user_id,
        "workspace_content_moved".to_string(),
        None,
        idempotency_key,
        serde_json::json!({ "resourceCount": 1 }),
      )
      .await
      .expect("replay in-app-only XWS notification");
    assert_eq!(first.id, replay.id, "the XWS idempotency key must prevent duplicates");
    assert_eq!(
      email.calls.load(Ordering::SeqCst),
      0,
      "in-app-only XWS notifications must never call the configured mail port"
    );
  }

  #[tokio::test]
  async fn notification_filters_are_normalized_once_for_list_and_count() {
    let store = Arc::new(InMemoryNotificationStore::default());
    let service = NotificationService::new(store);
    let user_id = Uuid::new_v4();
    let foreign_user_id = Uuid::new_v4();

    let mention = service
      .create_notification(user_id, "mention".to_string(), None, None, serde_json::json!({}))
      .await
      .expect("create mention");
    let comment = service
      .create_notification(user_id, "comment_reply".to_string(), None, None, serde_json::json!({}))
      .await
      .expect("create comment");
    service
      .create_notification(user_id, "invitation".to_string(), None, None, serde_json::json!({}))
      .await
      .expect("create invitation");
    service
      .create_notification(
        foreign_user_id,
        "mention".to_string(),
        None,
        None,
        serde_json::json!({}),
      )
      .await
      .expect("create foreign mention");
    service
      .mark_notification_read(user_id, comment.id)
      .await
      .expect("mark comment read");

    let filtered = service
      .list_notifications(
        user_id,
        NotificationListRequest {
          first: Some(10),
          include_read: Some(true),
          notification_types: Some(vec![
            "mention".to_string(),
            "comment_reply".to_string(),
            "mention".to_string(),
          ]),
          ..Default::default()
        },
      )
      .await
      .expect("list filtered notifications");
    assert_eq!(filtered.total_count, 2);
    assert_eq!(filtered.edges.len(), 2);
    assert_eq!(
      filtered.edges.iter().map(|edge| edge.node.id).collect::<BTreeSet<_>>(),
      BTreeSet::from([mention.id, comment.id])
    );

    let unread_filtered = service
      .list_notifications(
        user_id,
        NotificationListRequest {
          first: Some(10),
          notification_types: Some(vec!["mention".to_string(), "comment_reply".to_string()]),
          ..Default::default()
        },
      )
      .await
      .expect("list unread filtered notifications");
    assert_eq!(unread_filtered.total_count, 1);
    assert_eq!(unread_filtered.edges[0].node.id, mention.id);

    let empty_filter = service
      .list_notifications(
        user_id,
        NotificationListRequest {
          notification_types: Some(Vec::new()),
          ..Default::default()
        },
      )
      .await;
    assert!(matches!(empty_filter, Err(AuthError::InvalidInput(_))));
  }
}
