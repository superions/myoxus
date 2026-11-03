// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared `#[cfg(test)]` helpers for calendar code.
//!
//! Single source of truth for [`NullCalendarRepository`] — a no-op
//! [`CalendarRepository`] used by unit tests in `caldav::sync` and
//! `google_calendar::sync` that need to construct a sync service without a
//! real database. Centralising it here means new trait methods only need to be
//! added in one place; previously the impl was duplicated and silently drifted
//! every time the trait grew (root cause of LRN-20260429-CALDAV-DRIFT).

#![cfg(test)]

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use myoxus_domain::entities::{
  CalendarAccount, CalendarDeleteSnapshot, CalendarEvent, CalendarEventInstance, CalendarEventParticipant,
  CalendarEventTag, CalendarPendingWrite, CalendarReminder, CalendarReminderContext, CalendarSubscription,
  WebhookChannelInfo, WorkspaceCalendar, WorkspaceCalendarSettings,
};
use myoxus_domain::ids::CalendarSubscriptionId;
use myoxus_domain::repositories::{
  CalendarPendingWriteGuard, CalendarRepository, NativeEventInput, NativeEventUpdate, RepoResult,
};

/// No-op [`CalendarRepository`] for unit tests that construct a sync service
/// but never call repository methods (e.g. credential-build tests).
///
/// Returning methods are stubbed to `unimplemented!()`; `list`-style methods
/// return empty vecs / `None` so service construction code that probes them
/// during setup does not panic.
pub(crate) struct NullCalendarRepository;

struct NullCalendarPendingWriteGuard;

#[async_trait]
impl CalendarPendingWriteGuard for NullCalendarPendingWriteGuard {
  async fn detach_delete_intent_and_delete_event(
    &mut self,
    _event_id: Uuid,
    _snapshot: &CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite> {
    unimplemented!()
  }

  async fn delete_calendar_event(&mut self, _event_id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn release(self: Box<Self>) -> RepoResult<()> {
    Ok(())
  }
}

#[async_trait]
impl CalendarRepository for NullCalendarRepository {
  async fn acquire_mail_delivery_guard(
    &self,
    _intent_id: Uuid,
  ) -> RepoResult<Box<dyn myoxus_domain::repositories::CalendarMailDeliveryGuard>> {
    Err(myoxus_domain::repositories::RepositoryError::Storage(
      "test calendar mail delivery unavailable".into(),
    ))
  }

  async fn upsert_calendar_account(&self, _a: &CalendarAccount) -> RepoResult<CalendarAccount> {
    unimplemented!()
  }

  async fn update_calendar_account(&self, _a: &CalendarAccount) -> RepoResult<CalendarAccount> {
    unimplemented!()
  }

  async fn delete_calendar_account(&self, _id: Uuid, _user_id: Uuid) -> RepoResult<()> {
    unimplemented!()
  }

  async fn list_user_calendar_accounts(&self, _user_id: Uuid) -> RepoResult<Vec<CalendarAccount>> {
    Ok(vec![])
  }

  async fn upsert_calendar_subscription(&self, _s: &CalendarSubscription) -> RepoResult<CalendarSubscription> {
    unimplemented!()
  }

  async fn list_account_calendar_subscriptions(&self, _account_id: Uuid) -> RepoResult<Vec<CalendarSubscription>> {
    Ok(vec![])
  }

  async fn upsert_workspace_calendar(&self, _wc: &WorkspaceCalendar) -> RepoResult<WorkspaceCalendar> {
    unimplemented!()
  }

  async fn list_workspace_calendars(&self, _workspace_id: Uuid) -> RepoResult<Vec<WorkspaceCalendar>> {
    Ok(vec![])
  }

  async fn upsert_calendar_event(&self, _e: &CalendarEvent) -> RepoResult<CalendarEvent> {
    unimplemented!()
  }

  async fn replace_calendar_event_participants(
    &self,
    _event_id: Uuid,
    _p: &[CalendarEventParticipant],
  ) -> RepoResult<()> {
    Ok(())
  }

  async fn replace_calendar_event_reminders(&self, _event_id: Uuid, _r: &[CalendarReminder]) -> RepoResult<()> {
    Ok(())
  }

  async fn mark_calendar_reminder_status(
    &self,
    _reminder_id: Uuid,
    _delivered: bool,
    _at: DateTime<Utc>,
  ) -> RepoResult<()> {
    Ok(())
  }

  async fn acquire_reminder_delivery_guard(
    &self,
    _reminder_id: Uuid,
  ) -> RepoResult<Box<dyn myoxus_domain::repositories::CalendarReminderDeliveryGuard>> {
    Err(myoxus_domain::repositories::RepositoryError::Storage(
      "Calendar reminder delivery guard unavailable".into(),
    ))
  }

  async fn list_workspace_events(
    &self,
    _workspace_id: Uuid,
    _from: DateTime<Utc>,
    _to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEvent>> {
    Ok(vec![])
  }

  async fn list_caldav_accounts(&self) -> RepoResult<Vec<CalendarAccount>> {
    Ok(vec![])
  }

  async fn list_google_accounts(&self) -> RepoResult<Vec<CalendarAccount>> {
    Ok(vec![])
  }

  async fn get_calendar_account_by_id(&self, _id: Uuid) -> RepoResult<Option<CalendarAccount>> {
    Ok(None)
  }

  async fn get_calendar_subscription_by_id(&self, _id: Uuid) -> RepoResult<Option<CalendarSubscription>> {
    Ok(None)
  }

  async fn find_subscription_by_channel_id(&self, _channel_id: &str) -> RepoResult<Option<CalendarSubscription>> {
    Ok(None)
  }
  async fn touch_calendar_subscription(&self, _subscription_id: CalendarSubscriptionId) -> RepoResult<()> {
    Ok(())
  }

  async fn list_subscriptions_expiring_within(&self, _within_hours: i64) -> RepoResult<Vec<CalendarSubscription>> {
    Ok(vec![])
  }

  async fn update_subscription_webhook_channel(
    &self,
    _subscription_id: Uuid,
    _channel: Option<&WebhookChannelInfo>,
  ) -> RepoResult<()> {
    Ok(())
  }

  async fn update_participant_response_status(
    &self,
    _participant_id: Uuid,
    _status: &str,
  ) -> RepoResult<Option<CalendarEventParticipant>> {
    Ok(None)
  }

  async fn get_calendar_reminder_context(&self, _reminder_id: Uuid) -> RepoResult<Option<CalendarReminderContext>> {
    Ok(None)
  }

  async fn upsert_event_instance(&self, _instance: &CalendarEventInstance) -> RepoResult<CalendarEventInstance> {
    unimplemented!()
  }

  async fn list_event_instances(
    &self,
    _event_id: Uuid,
    _from: DateTime<Utc>,
    _to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>> {
    Ok(vec![])
  }

  async fn list_instances_by_time_range(
    &self,
    _workspace_id: Uuid,
    _from: DateTime<Utc>,
    _to: DateTime<Utc>,
  ) -> RepoResult<Vec<CalendarEventInstance>> {
    Ok(vec![])
  }

  async fn cancel_event_instance(&self, _instance_id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn delete_event_instances_by_event(&self, _event_id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn get_calendar_event(&self, _event_id: Uuid) -> RepoResult<Option<CalendarEvent>> {
    Ok(None)
  }

  async fn delete_calendar_event(&self, _event_id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn find_instance_by_event_and_start(
    &self,
    _event_id: Uuid,
    _instance_start: DateTime<Utc>,
  ) -> RepoResult<Option<CalendarEventInstance>> {
    Ok(None)
  }

  async fn update_event_etag(&self, _event_id: Uuid, _etag: &str, _remote_href: &str) -> RepoResult<()> {
    Ok(())
  }

  async fn enqueue_pending_write(
    &self,
    _event_id: Uuid,
    _operation: &str,
    _payload: Option<serde_json::Value>,
  ) -> RepoResult<CalendarPendingWrite> {
    unimplemented!()
  }

  async fn detach_delete_intent_and_delete_event(
    &self,
    _event_id: Uuid,
    _snapshot: &CalendarDeleteSnapshot,
  ) -> RepoResult<CalendarPendingWrite> {
    unimplemented!()
  }

  async fn acquire_pending_write_guard(&self, _event_id: Uuid) -> RepoResult<Box<dyn CalendarPendingWriteGuard>> {
    Ok(Box::new(NullCalendarPendingWriteGuard))
  }

  async fn get_pending_write(&self, _id: Uuid) -> RepoResult<Option<CalendarPendingWrite>> {
    Ok(None)
  }

  async fn list_due_pending_writes(&self, _now: DateTime<Utc>, _limit: i64) -> RepoResult<Vec<CalendarPendingWrite>> {
    Ok(vec![])
  }

  async fn update_pending_write_retry(
    &self,
    _id: Uuid,
    _retry_count: i32,
    _next_retry_at: Option<DateTime<Utc>>,
    _last_error: &str,
  ) -> RepoResult<()> {
    Ok(())
  }

  async fn delete_pending_write(&self, _id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn insert_native_event(&self, _input: &NativeEventInput) -> RepoResult<CalendarEvent> {
    unimplemented!()
  }

  async fn update_native_event(
    &self,
    _event_id: Uuid,
    _patch: &NativeEventUpdate,
  ) -> RepoResult<Option<CalendarEvent>> {
    Ok(None)
  }

  async fn upsert_workspace_calendar_settings(
    &self,
    _settings: &WorkspaceCalendarSettings,
  ) -> RepoResult<WorkspaceCalendarSettings> {
    unimplemented!()
  }

  async fn get_workspace_calendar_settings(
    &self,
    _workspace_id: Uuid,
  ) -> RepoResult<Option<WorkspaceCalendarSettings>> {
    Ok(None)
  }

  async fn insert_calendar_event_tag(&self, _tag: &CalendarEventTag) -> RepoResult<CalendarEventTag> {
    unimplemented!()
  }

  async fn update_calendar_event_tag(
    &self,
    _tag_id: Uuid,
    _workspace_id: Uuid,
    _name: &str,
    _color: &str,
  ) -> RepoResult<Option<CalendarEventTag>> {
    Ok(None)
  }

  async fn delete_calendar_event_tag(&self, _tag_id: Uuid, _workspace_id: Uuid) -> RepoResult<()> {
    Ok(())
  }

  async fn list_calendar_event_tags(&self, _workspace_id: Uuid) -> RepoResult<Vec<CalendarEventTag>> {
    Ok(vec![])
  }

  async fn add_event_exdate(&self, _event_id: Uuid, _instance_start: DateTime<Utc>) -> RepoResult<()> {
    Ok(())
  }
}
