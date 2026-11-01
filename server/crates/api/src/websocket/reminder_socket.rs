// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-05: Socket.IO implementation of `ReminderDispatchedPort`.
//!
//! After a calendar reminder is dispatched, `SocketReminderPort` emits
//! `calendar_reminder_due` to the user's socket via the notification fanout
//! channel. The client's notification handler picks it up as a push event
//! and shows an in-app toast + browser notification (INV-CAL-REMINDER-02).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::calendar::ReminderDispatchedPort;
use myoxus_domain::ids::CalendarEventId;
use serde_json::json;
use uuid::Uuid;

use super::fanout::publish_user_notification;

/// Wires `ReminderDispatchedPort` to the Socket.IO notification fanout channel.
pub struct SocketReminderPort(pub Option<std::sync::Arc<super::redis_adapter::RedisWsAdapter>>);

#[async_trait]
impl ReminderDispatchedPort for SocketReminderPort {
  async fn notify_reminder_due(&self, user_id: Uuid, event_id: CalendarEventId, scheduled_for: DateTime<Utc>) {
    publish_user_notification(
      self.0.as_deref(),
      user_id,
      "calendar_reminder_due",
      json!({
        "eventId": event_id,
        "scheduledFor": scheduled_for.to_rfc3339(),
      }),
    )
    .await;
  }
}
