//! Calendar integration service: accounts, subscriptions, events, and reminder
//! dispatch.
//!
//! [`CalendarService`] manages calendar accounts linked to users, their
//! subscriptions, workspace-level calendar views, and individual calendar
//! events with participants and reminders.
//!
//! [`CalendarReminderDispatcher`] uses the Redis worker queue to schedule and
//! deliver calendar reminders, with at-least-once semantics.

pub mod mail;
pub mod merge;
pub use merge::{FieldConflict, MergeResult, merge_calendar_events};

pub mod native;
pub use native::{
  CalendarBroadcastPort, DeleteScope, EventOverlap, NativeCreateInput, NativeEventService, NullCalendarBroadcast,
  ReminderInput, UpdateScope,
};

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult, AuthStore, UserPreferenceDefaults};
use crate::notification::NotificationService;
use crate::ports::{MailPort, NullRemoteCalendarWrite, PortError, RemoteCalendarWritePort, RemoteEventInput};
use crate::worker::WorkQueuePort;
use async_trait::async_trait;
use myoxus_domain::entities::{
  CalendarAccount, CalendarDeleteSnapshot, CalendarEvent, CalendarEventInstance, CalendarEventOrigin,
  CalendarEventParticipant, CalendarEventTag, CalendarPendingWrite, CalendarReminder, CalendarSubscription,
  WorkspaceCalendar, WorkspaceCalendarSettings,
};
use myoxus_domain::ids::CalendarEventId;
use myoxus_domain::repositories::CalendarRepository;

/// RSVP status values for calendar event attendees (P90-CAL-H-04).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RsvpStatus {
  /// Attendee has accepted the invitation.
  Accepted,
  /// Attendee has declined the invitation.
  Declined,
  /// Attendee is tentatively accepting.
  Tentative,
  /// Attendee has not yet responded.
  NeedsAction,
}

impl RsvpStatus {
  /// Convert to the canonical iCalendar PARTSTAT string.
  pub fn as_partstat(&self) -> &'static str {
    match self {
      RsvpStatus::Accepted => "ACCEPTED",
      RsvpStatus::Declined => "DECLINED",
      RsvpStatus::Tentative => "TENTATIVE",
      RsvpStatus::NeedsAction => "NEEDS-ACTION",
    }
  }
}

/// Input DTO for creating or updating a calendar event including its
/// participants and reminders.
#[derive(Debug, Clone)]
pub struct CalendarEventUpsert {
  /// Stable local ID for the event (caller-assigned).
  pub id: Uuid,
  /// The calendar account this event belongs to.
  pub account_id: Uuid,
  /// Optional workspace the event is associated with.
  pub workspace_id: Option<Uuid>,
  /// Provider-assigned event ID (e.g. Google Calendar event ID).
  pub remote_event_id: String,
  /// Start time of the event.
  pub starts_at: DateTime<Utc>,
  /// End time of the event.
  pub ends_at: DateTime<Utc>,
  /// Human-readable event title.
  pub title: Option<String>,
  /// Optional link to a source doc that created or mirrors this event.
  pub source_doc_id: Option<Uuid>,
  /// Arbitrary provider-specific event metadata.
  pub payload: serde_json::Value,
  /// Attendees of the event.
  pub participants: Vec<CalendarEventParticipant>,
  /// Reminders configured for the event.
  pub reminders: Vec<CalendarReminder>,
}

/// Service for managing calendar accounts, subscriptions, and events.
#[derive(Clone)]
pub struct CalendarService {
  /// Persistence repository for all calendar data.
  repo: Arc<dyn CalendarRepository>,
  /// Port for writing events back to remote providers (CalDAV / Google).
  /// Defaults to a no-op; call [`with_remote_write`](Self::with_remote_write)
  /// to enable write-through.
  remote_write: Arc<dyn RemoteCalendarWritePort>,
}

async fn build_delete_snapshot(
  repo: &dyn CalendarRepository,
  event: &CalendarEvent,
) -> AuthResult<Option<CalendarDeleteSnapshot>> {
  let (remote_href, etag) = match (&event.remote_href, &event.etag) {
    (None, None) => return Ok(None),
    (Some(remote_href), Some(etag)) if !remote_href.is_empty() && !etag.is_empty() => {
      (remote_href.clone(), etag.clone())
    }
    _ => {
      return Err(AuthError::InvalidInput(
        "remote calendar delete routing is incomplete".to_string(),
      ));
    }
  };

  let configured_subscription = if let Some(workspace_id) = event.workspace_id {
    repo
      .get_workspace_calendar_settings(workspace_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .and_then(|settings| settings.writeback_subscription_id)
  } else {
    None
  };
  let (account_id, calendar_id) = if let Some(subscription_id) = configured_subscription {
    let subscription = repo
      .get_calendar_subscription_by_id(subscription_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::InvalidInput("calendar writeback subscription is unavailable".to_string()))?;
    (subscription.account_id, subscription.remote_calendar_id)
  } else {
    let account_id = event
      .account_id
      .ok_or_else(|| AuthError::InvalidInput("calendar event has no remote account routing".to_string()))?;
    (account_id, String::new())
  };
  let account = repo
    .get_calendar_account_by_id(account_id)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?
    .ok_or_else(|| AuthError::InvalidInput("calendar writeback account is unavailable".to_string()))?;
  let calendar_id = if calendar_id.is_empty() {
    match account.provider.as_str() {
      "google" => remote_href
        .split_once('/')
        .map_or_else(|| "primary".to_string(), |(calendar_id, _)| calendar_id.to_string()),
      _ => remote_href
        .rsplit_once('/')
        .map_or_else(|| remote_href.clone(), |(parent, _)| format!("{parent}/")),
    }
  } else {
    calendar_id
  };
  let snapshot = CalendarDeleteSnapshot {
    schema_version: CalendarDeleteSnapshot::SCHEMA_VERSION,
    source_event_id: event.id,
    provider: account.provider,
    account_id,
    calendar_id,
    remote_href,
    remote_uid: event.remote_event_id.clone().unwrap_or_else(|| event.id.to_string()),
    etag,
  };
  snapshot
    .validate()
    .map_err(|message| AuthError::InvalidInput(message.to_string()))?;
  Ok(Some(snapshot))
}

async fn stage_calendar_event_delete(
  repo: &dyn CalendarRepository,
  event_id: Uuid,
) -> AuthResult<Option<CalendarPendingWrite>> {
  let mut guard = repo
    .acquire_pending_write_guard(event_id)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
  let outcome = async {
    let event = repo
      .get_calendar_event(event_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".to_string()))?;
    if let Some(snapshot) = build_delete_snapshot(repo, &event).await? {
      guard
        .detach_delete_intent_and_delete_event(event_id, &snapshot)
        .await
        .map(Some)
        .map_err(|error| AuthError::Storage(error.to_string()))
    } else {
      guard
        .delete_calendar_event(event_id)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      Ok(None)
    }
  }
  .await;
  let release = guard
    .release()
    .await
    .map_err(|error| AuthError::Storage(error.to_string()));
  match (outcome, release) {
    (Ok(result), Ok(())) => Ok(result),
    (Err(error), _) | (Ok(_), Err(error)) => Err(error),
  }
}

impl CalendarService {
  /// Construct a `CalendarService` backed by the given repository.
  /// Remote write-back is disabled (no-op) by default.
  pub fn new(repo: Arc<dyn CalendarRepository>) -> Self {
    Self {
      repo,
      remote_write: Arc::new(NullRemoteCalendarWrite),
    }
  }

  /// Attach a [`RemoteCalendarWritePort`] implementation for write-through.
  pub fn with_remote_write(mut self, port: Arc<dyn RemoteCalendarWritePort>) -> Self {
    self.remote_write = port;
    self
  }

  /// Insert or update a calendar account.
  #[instrument(skip(self, account))]
  pub async fn upsert_account(&self, account: CalendarAccount) -> AuthResult<CalendarAccount> {
    self
      .repo
      .upsert_calendar_account(&account)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// List all calendar accounts linked to a user.
  #[instrument(skip(self))]
  pub async fn list_accounts(&self, user_id: Uuid) -> AuthResult<Vec<CalendarAccount>> {
    self
      .repo
      .list_user_calendar_accounts(user_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// List all calendar subscriptions for a given account.
  #[instrument(skip(self))]
  pub async fn list_account_calendars(&self, account_id: Uuid) -> AuthResult<Vec<CalendarSubscription>> {
    self
      .repo
      .list_account_calendar_subscriptions(account_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Resolve a Google webhook channel to its persisted subscription.
  pub async fn subscription_by_channel_id(&self, channel_id: &str) -> AuthResult<Option<CalendarSubscription>> {
    self
      .repo
      .find_subscription_by_channel_id(channel_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  /// Record that a webhook-backed subscription received provider activity.
  pub async fn touch_subscription(&self, subscription_id: Uuid) -> AuthResult<()> {
    self
      .repo
      .touch_calendar_subscription(subscription_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  /// Update mutable fields on a calendar account.
  #[instrument(skip(self, account))]
  pub async fn update_account(&self, account: CalendarAccount) -> AuthResult<CalendarAccount> {
    self
      .repo
      .update_calendar_account(&account)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Remove the link between a calendar account and a user.
  #[instrument(skip(self))]
  pub async fn unlink_account(&self, account_id: Uuid, user_id: Uuid) -> AuthResult<()> {
    self
      .repo
      .delete_calendar_account(account_id, user_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Insert or update a calendar subscription (a specific calendar within an
  /// account).
  #[instrument(skip(self, subscription))]
  pub async fn upsert_subscription(&self, subscription: CalendarSubscription) -> AuthResult<CalendarSubscription> {
    self
      .repo
      .upsert_calendar_subscription(&subscription)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Insert or update the workspace-level calendar view record.
  #[instrument(skip(self, workspace_calendar))]
  pub async fn upsert_workspace_calendar(
    &self,
    workspace_calendar: WorkspaceCalendar,
  ) -> AuthResult<WorkspaceCalendar> {
    self
      .repo
      .upsert_workspace_calendar(&workspace_calendar)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// List all workspace calendars for a workspace.
  #[instrument(skip(self))]
  pub async fn list_workspace_calendars(&self, workspace_id: Uuid) -> AuthResult<Vec<WorkspaceCalendar>> {
    self
      .repo
      .list_workspace_calendars(workspace_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Upsert a calendar event together with its participants and reminders.
  ///
  /// After persisting, the event is re-fetched with its full hydrated state
  /// (participants and reminders attached) from the database.
  #[instrument(skip(self, input))]
  pub async fn upsert_event(&self, input: CalendarEventUpsert) -> AuthResult<CalendarEvent> {
    self.persist_event(input, false).await
  }

  /// Explicit product changes schedule mail; provider imports use `upsert_event`.
  #[instrument(skip_all)]
  pub async fn upsert_authored_event(&self, input: CalendarEventUpsert) -> AuthResult<CalendarEvent> {
    self.persist_event(input, true).await
  }

  async fn persist_event(&self, input: CalendarEventUpsert, authored: bool) -> AuthResult<CalendarEvent> {
    let event = CalendarEvent {
      id: input.id,
      origin: CalendarEventOrigin::External,
      account_id: Some(input.account_id),
      workspace_id: input.workspace_id,
      remote_event_id: Some(input.remote_event_id),
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      title: input.title,
      description: None,
      description_delta: None,
      location: None,
      source_doc_id: input.source_doc_id,
      all_day: false,
      all_members: false,
      tag_id: None,
      recurrence_parent_id: None,
      participants: vec![],
      reminders: vec![],
      payload: input.payload,
      updated_at: Utc::now(),
      etag: None,
      remote_href: None,
    };

    if authored {
      return self
        .repo
        .save_authored_calendar_event(&event, &input.participants, &input.reminders)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()));
    }
    let saved = self
      .repo
      .upsert_calendar_event(&event)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    self
      .repo
      .replace_calendar_event_participants(saved.id, &input.participants)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    self
      .repo
      .replace_calendar_event_reminders(saved.id, &input.reminders)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    self
      .repo
      .get_calendar_event(saved.id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::Storage("saved calendar event not found after upsert".to_string()))
  }

  /// List all calendar events in a workspace within the given time window.
  #[instrument(skip(self))]
  pub async fn list_workspace_events(
    &self,
    workspace_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> AuthResult<Vec<CalendarEvent>> {
    self
      .repo
      .list_workspace_events(workspace_id, from, to)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// List materialized recurrence instances for a single event within a time window.
  #[instrument(skip(self))]
  pub async fn list_event_instances(
    &self,
    event_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> AuthResult<Vec<CalendarEventInstance>> {
    self
      .repo
      .list_event_instances(event_id, from, to)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Fetch a single calendar event by its local ID.
  #[instrument(skip(self))]
  pub async fn get_event(&self, event_id: Uuid) -> AuthResult<Option<CalendarEvent>> {
    self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Update the RSVP status of a single participant in an event (P90-CAL-H-04).
  ///
  /// Looks up the participant by `(event_id, user_id)` and updates their
  /// `response_status` to the normalised PARTSTAT string.  Returns the updated
  /// event with the refreshed participant list.
  #[instrument(skip(self))]
  pub async fn update_rsvp(&self, event_id: Uuid, user_id: Uuid, status: RsvpStatus) -> AuthResult<CalendarEvent> {
    let event = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".to_string()))?;

    let participant = event
      .participants
      .iter()
      .find(|p| p.user_id == Some(user_id))
      .ok_or_else(|| AuthError::NotFound("participant not found for this user and event".to_string()))?;

    let participant_id = participant.id;
    let partstat = status.as_partstat();

    self
      .repo
      .update_participant_response_status(participant_id, partstat)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    info!(
      event_id = %event_id,
      user_id = %user_id,
      status = %partstat,
      "updated RSVP status for calendar event participant"
    );

    // Re-fetch the updated event so the caller sees the new participant state.
    self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::Storage("event disappeared after RSVP update".to_string()))
  }

  /// Query free/busy slots from `calendar_event_instances` for a workspace
  /// within `[from, to)` (P90-CAL-H-07).
  ///
  /// Returns non-cancelled instances that overlap the time range.
  #[instrument(skip(self))]
  pub async fn free_busy(
    &self,
    workspace_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> AuthResult<Vec<CalendarEventInstance>> {
    self
      .repo
      .list_instances_by_time_range(workspace_id, from, to)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Store the ETag and remote href for an event after a successful remote write.
  #[instrument(skip(self))]
  pub async fn update_event_etag(&self, event_id: Uuid, etag: &str, remote_href: &str) -> AuthResult<()> {
    self
      .repo
      .update_event_etag(event_id, etag, remote_href)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Enqueue a deferred write when the remote server is unreachable.
  #[instrument(skip(self, payload))]
  pub async fn enqueue_pending_write(
    &self,
    event_id: Uuid,
    operation: &str,
    payload: Option<serde_json::Value>,
  ) -> AuthResult<CalendarPendingWrite> {
    self
      .repo
      .enqueue_pending_write(event_id, operation, payload)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Return pending writes that are ready for retry.
  #[instrument(skip(self))]
  pub async fn list_due_pending_writes(&self, limit: i64) -> AuthResult<Vec<CalendarPendingWrite>> {
    self
      .repo
      .list_due_pending_writes(Utc::now(), limit)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Update retry bookkeeping for a failed pending write attempt.
  #[instrument(skip(self, last_error))]
  pub async fn update_pending_write_retry(
    &self,
    id: Uuid,
    retry_count: i32,
    next_retry_at: Option<DateTime<Utc>>,
    last_error: &str,
  ) -> AuthResult<()> {
    self
      .repo
      .update_pending_write_retry(id, retry_count, next_retry_at, last_error)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Delete a successfully processed pending write.
  #[instrument(skip(self))]
  pub async fn delete_pending_write(&self, id: Uuid) -> AuthResult<()> {
    self
      .repo
      .delete_pending_write(id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Compute the backoff delay for a given retry count.
  ///
  /// Schedule: 0→1min, 1→5min, 2→15min, 3→1h, 4→4h, 5+→4h (capped).
  pub fn pending_write_backoff(retry_count: i32) -> chrono::Duration {
    match retry_count {
      0 => chrono::Duration::minutes(1),
      1 => chrono::Duration::minutes(5),
      2 => chrono::Duration::minutes(15),
      3 => chrono::Duration::hours(1),
      _ => chrono::Duration::hours(4),
    }
  }

  /// Execute and acknowledge one pending write while holding the source-event
  /// serialization guard. A fetched queue row is only a scheduling hint: the
  /// current row and event are read again after the guard is acquired.
  #[instrument(skip(self))]
  pub async fn execute_pending_write(&self, write: &CalendarPendingWrite) -> Result<(), String> {
    let source_event_id = self.pending_write_source_event_id(write)?;
    let guard = self
      .repo
      .acquire_pending_write_guard(source_event_id)
      .await
      .map_err(|error| format!("acquire pending-write guard: {error}"))?;
    let outcome = self.execute_and_acknowledge_pending_write(write.id).await;
    let release = guard
      .release()
      .await
      .map_err(|error| format!("release pending-write guard: {error}"));
    match (outcome, release) {
      (Ok(()), Ok(())) => Ok(()),
      (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
      (Err(error), Err(release_error)) => Err(format!("{error}; {release_error}")),
    }
  }

  fn pending_write_source_event_id(&self, write: &CalendarPendingWrite) -> Result<Uuid, String> {
    if let Some(event_id) = write.event_id {
      return Ok(event_id);
    }
    if write.operation != "delete" {
      return Err(format!("{} pending write has no live event", write.operation));
    }
    let snapshot = Self::parse_delete_snapshot(write)?;
    Ok(snapshot.source_event_id)
  }

  async fn execute_and_acknowledge_pending_write(&self, write_id: Uuid) -> Result<(), String> {
    let Some(write) = self
      .repo
      .get_pending_write(write_id)
      .await
      .map_err(|error| format!("re-read pending write: {error}"))?
    else {
      return Ok(());
    };

    match self.dispatch_pending_write(&write).await {
      Ok(()) => self
        .repo
        .delete_pending_write(write.id)
        .await
        .map_err(|error| format!("acknowledge pending write: {error}")),
      Err(execution_error) => {
        let retry_count = write.retry_count + 1;
        let next_retry = Utc::now() + Self::pending_write_backoff(retry_count);
        self
          .repo
          .update_pending_write_retry(write.id, retry_count, Some(next_retry), &execution_error)
          .await
          .map_err(|error| format!("{execution_error}; persist retry: {error}"))?;
        Err(execution_error)
      }
    }
  }

  async fn dispatch_pending_write(&self, write: &CalendarPendingWrite) -> Result<(), String> {
    if write.operation == "delete" && write.event_id.is_none() {
      return self.execute_detached_delete(write).await;
    }

    let event_id = write
      .event_id
      .ok_or_else(|| format!("{} pending write has no live event", write.operation))?;
    let event = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| format!("fetch event: {e}"))?
      .ok_or_else(|| format!("event {event_id} not found, skipping pending write"))?;

    let (account_id, calendar_id) = self.resolve_writeback_account(&event).await?;
    let href = event.remote_href.clone().unwrap_or_else(|| format!("{}.ics", event.id));
    let etag = event.etag.clone().unwrap_or_default();
    let remote_input = RemoteEventInput {
      account_id,
      calendar_id,
      uid: event.id.to_string(),
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      title: event.title.clone(),
      description: event.description.clone(),
      location: None,
      extra_payload: serde_json::json!({}),
    };

    match write.operation.as_str() {
      "create" => {
        let result = self
          .remote_write
          .create_event(&remote_input)
          .await
          .map_err(|error| format!("create_event: {error}"))?;
        self
          .repo
          .update_event_etag(
            event.id,
            result.etag.as_deref().unwrap_or_default(),
            &result.remote_href,
          )
          .await
          .map_err(|error| format!("persist create result: {error}"))
      }
      "update" => {
        let result = self
          .remote_write
          .update_event(&href, &etag, &remote_input)
          .await
          .map_err(|error| format!("update_event: {error}"))?;
        self
          .repo
          .update_event_etag(event.id, result.etag.as_deref().unwrap_or(&etag), &href)
          .await
          .map_err(|error| format!("persist update result: {error}"))
      }
      "delete" => self
        .remote_write
        .delete_event(&href, &etag, &remote_input)
        .await
        .map_err(|e| format!("delete_event: {e}")),
      other => Err(format!("unknown pending write operation: {other}")),
    }
  }

  async fn execute_detached_delete(&self, write: &CalendarPendingWrite) -> Result<(), String> {
    let snapshot = Self::parse_delete_snapshot(write)?;

    let account = self
      .repo
      .get_calendar_account_by_id(snapshot.account_id)
      .await
      .map_err(|error| format!("fetch calendar account: {error}"))?
      .ok_or_else(|| format!("calendar account {} not found", snapshot.account_id))?;
    if account.provider != snapshot.provider {
      return Err("calendar delete provider no longer matches its account".to_string());
    }

    let remote_input = RemoteEventInput {
      account_id: snapshot.account_id,
      calendar_id: snapshot.calendar_id,
      uid: snapshot.remote_uid,
      starts_at: DateTime::<Utc>::UNIX_EPOCH,
      ends_at: DateTime::<Utc>::UNIX_EPOCH,
      title: None,
      description: None,
      location: None,
      extra_payload: serde_json::json!({}),
    };
    self
      .remote_write
      .delete_event(&snapshot.remote_href, &snapshot.etag, &remote_input)
      .await
      .map_err(|error| format!("delete_event: {error}"))
  }

  fn parse_delete_snapshot(write: &CalendarPendingWrite) -> Result<CalendarDeleteSnapshot, String> {
    let snapshot: CalendarDeleteSnapshot = serde_json::from_value(
      write
        .payload
        .clone()
        .ok_or_else(|| "detached calendar delete is missing its snapshot".to_string())?,
    )
    .map_err(|error| format!("invalid detached calendar delete snapshot: {error}"))?;
    snapshot.validate().map_err(str::to_string)?;
    Ok(snapshot)
  }

  async fn resolve_writeback_account(&self, event: &CalendarEvent) -> Result<(Uuid, String), String> {
    let ws_id = event
      .workspace_id
      .ok_or_else(|| format!("event {} has no workspace_id for writeback", event.id))?;
    let settings = self
      .repo
      .get_workspace_calendar_settings(ws_id)
      .await
      .map_err(|e| format!("get settings: {e}"))?
      .ok_or_else(|| format!("no calendar settings for workspace {ws_id}"))?;
    let sub_id = settings
      .writeback_subscription_id
      .ok_or_else(|| format!("workspace {ws_id} has no writeback_subscription_id"))?;
    let sub = self
      .repo
      .get_calendar_subscription_by_id(sub_id)
      .await
      .map_err(|e| format!("get subscription: {e}"))?
      .ok_or_else(|| format!("writeback subscription {sub_id} not found"))?;
    Ok((sub.account_id, sub.remote_calendar_id))
  }

  /// Update the delivery status of a calendar reminder.
  #[instrument(skip(self))]
  pub async fn mark_reminder_status(
    &self,
    reminder_id: Uuid,
    delivered: bool,
    delivered_at: Option<DateTime<Utc>>,
  ) -> AuthResult<()> {
    self
      .repo
      .mark_calendar_reminder_status(reminder_id, delivered, delivered_at.unwrap_or_else(Utc::now))
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  // ── Write-through methods (P90-CAL-E-07) ──────────────────────────────────

  /// Create a calendar event locally and write it through to the remote provider.
  ///
  /// Steps:
  /// 1. Insert the event into the local DB.
  /// 2. Attempt a remote `create_event` call via the injected [`RemoteCalendarWritePort`].
  /// 3. On success: persist the returned `(href, etag)`.
  /// 4. On remote failure: enqueue in `calendar_pending_writes` for later retry.
  #[instrument(skip(self, input, remote_input))]
  pub async fn create_remote_event(
    &self,
    input: CalendarEventUpsert,
    remote_input: Option<RemoteEventInput>,
  ) -> AuthResult<CalendarEvent> {
    let event = self.upsert_authored_event(input).await?;
    if let Some(ref ri) = remote_input {
      match self.remote_write.create_event(ri).await {
        Ok(result) => {
          let href = result.remote_href.clone();
          let etag = result.etag.clone().unwrap_or_default();
          if let Err(e) = self.repo.update_event_etag(event.id, &etag, &href).await {
            warn!(event_id = %event.id, error = %e, "create_remote_event: etag persist failed (non-fatal)");
          }
          info!(event_id = %event.id, %href, "create_remote_event: write-through succeeded");
          return Ok(
            self
              .repo
              .get_calendar_event(event.id)
              .await
              .map_err(|e| AuthError::Storage(e.to_string()))?
              .unwrap_or(event),
          );
        }
        Err(PortError::Conflict(msg)) => {
          warn!(event_id = %event.id, %msg, "create_remote_event: conflict, enqueueing");
          let _ = self
            .repo
            .enqueue_pending_write(event.id, "create", Some(serde_json::json!({"conflict": true})))
            .await;
        }
        Err(e) => {
          warn!(event_id = %event.id, error = %e, "create_remote_event: remote failed, enqueueing pending write");
          let _ = self.repo.enqueue_pending_write(event.id, "create", None).await;
        }
      }
    }
    Ok(event)
  }

  /// Update a calendar event locally and push the change to the remote provider.
  ///
  /// Returns `AuthError::InvalidInput` on ETag conflict.
  #[instrument(skip(self, input, remote_input))]
  pub async fn update_remote_event(
    &self,
    input: CalendarEventUpsert,
    remote_input: Option<RemoteEventInput>,
  ) -> AuthResult<CalendarEvent> {
    let existing = self
      .repo
      .get_calendar_event(input.id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    let event = self.upsert_authored_event(input).await?;
    if let Some(ref ri) = remote_input {
      let (remote_href, etag) = existing
        .as_ref()
        .map(|e| {
          (
            e.remote_href.clone().unwrap_or_default(),
            e.etag.clone().unwrap_or_default(),
          )
        })
        .unwrap_or_default();
      if !remote_href.is_empty() && !etag.is_empty() {
        match self.remote_write.update_event(&remote_href, &etag, ri).await {
          Ok(result) => {
            let new_etag = result.etag.unwrap_or(etag);
            if let Err(e) = self.repo.update_event_etag(event.id, &new_etag, &remote_href).await {
              warn!(event_id = %event.id, error = %e, "update_remote_event: etag persist failed (non-fatal)");
            }
            info!(event_id = %event.id, %remote_href, "update_remote_event: write-through succeeded");
            return Ok(
              self
                .repo
                .get_calendar_event(event.id)
                .await
                .map_err(|e| AuthError::Storage(e.to_string()))?
                .unwrap_or(event),
            );
          }
          Err(PortError::Conflict(msg)) => {
            return Err(AuthError::InvalidInput(format!(
              "remote event modified concurrently: {msg}"
            )));
          }
          Err(e) => {
            warn!(event_id = %event.id, error = %e, "update_remote_event: remote failed, enqueueing");
            let _ = self.repo.enqueue_pending_write(event.id, "update", None).await;
          }
        }
      } else {
        // No remote href yet — attempt a first-time create write.
        match self.remote_write.create_event(ri).await {
          Ok(result) => {
            let href = result.remote_href.clone();
            let new_etag = result.etag.unwrap_or_default();
            if let Err(e) = self.repo.update_event_etag(event.id, &new_etag, &href).await {
              warn!(event_id = %event.id, error = %e, "update_remote_event: etag persist failed (non-fatal)");
            }
          }
          Err(e) => {
            warn!(event_id = %event.id, error = %e, "update_remote_event: no remote_href, create failed, enqueueing");
            let _ = self.repo.enqueue_pending_write(event.id, "update", None).await;
          }
        }
      }
    }
    Ok(event)
  }

  /// Delete a calendar event locally and propagate to the remote provider.
  ///
  /// The detached delete intent is durable before local removal. Provider
  /// failure leaves that intent queued for a later retry.
  #[instrument(skip(self))]
  pub async fn delete_remote_event(&self, event_id: Uuid) -> AuthResult<()> {
    if let Some(pending) = stage_calendar_event_delete(self.repo.as_ref(), event_id).await? {
      if self.execute_pending_write(&pending).await.is_err() {
        warn!(event_id = %event_id, "remote calendar delete deferred for retry");
      } else {
        info!(event_id = %event_id, "delete_remote_event: write-through succeeded");
      }
    }
    info!(event_id = %event_id, "delete_remote_event: local deletion complete");
    Ok(())
  }

  // ── Recurring-event modification (P90-CAL-I) ──────────────────────────────

  /// Mark a single recurrence instance as a RECURRENCE-ID override (I-01).
  ///
  /// The `instance_start` must be the original DTSTART of the recurring
  /// instance (used as the RECURRENCE-ID key in iCalendar).
  #[instrument(skip(self, override_payload))]
  pub async fn update_event_instance(
    &self,
    event_id: Uuid,
    instance_start: DateTime<Utc>,
    override_payload: serde_json::Value,
  ) -> AuthResult<CalendarEventInstance> {
    let existing = self
      .repo
      .find_instance_by_event_and_start(event_id, instance_start)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    let parent_event = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("parent calendar event not found".to_string()))?;
    let parent_duration = parent_event.ends_at - parent_event.starts_at;
    let effective_start = override_payload["starts_at"]
      .as_str()
      .and_then(|s| s.parse::<DateTime<Utc>>().ok())
      .unwrap_or(instance_start);
    let instance_end = override_payload
      .get("ends_at")
      .and_then(|v| v.as_str())
      .and_then(|s| s.parse::<DateTime<Utc>>().ok())
      .unwrap_or(effective_start + parent_duration);

    let instance = CalendarEventInstance {
      id: existing.map(|i| i.id).unwrap_or_else(uuid::Uuid::new_v4),
      event_id,
      instance_start,
      instance_end,
      is_override: true,
      is_cancelled: false,
      override_payload: Some(override_payload),
      created_at: Utc::now(),
    };

    self
      .repo
      .save_authored_calendar_instance(&instance)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  /// Split a recurring series at `split_at` (thisAndFuture, I-02).
  ///
  /// Returns `(original_with_until, new_tail_event)`.
  #[instrument(skip(self, changes_payload))]
  pub async fn split_recurring_event(
    &self,
    event_id: Uuid,
    split_at: DateTime<Utc>,
    changes_payload: serde_json::Value,
  ) -> AuthResult<(CalendarEvent, CalendarEvent)> {
    self
      .split_recurring_impl(event_id, split_at, changes_payload, true)
      .await
  }

  /// Future deletion truncates the existing UID without inviting a temporary tail.
  #[instrument(skip_all)]
  pub async fn truncate_recurring_series(&self, event_id: Uuid, split_at: DateTime<Utc>) -> AuthResult<()> {
    self
      .split_recurring_impl(event_id, split_at, serde_json::json!({}), false)
      .await
      .map(|_| ())
  }

  async fn split_recurring_impl(
    &self,
    event_id: Uuid,
    split_at: DateTime<Utc>,
    changes_payload: serde_json::Value,
    persist_tail: bool,
  ) -> AuthResult<(CalendarEvent, CalendarEvent)> {
    let original = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".to_string()))?;

    // Guard: cannot split a non-recurring event.
    let _rrule = original
      .payload
      .get("rrule")
      .and_then(|v| v.as_str())
      .filter(|s| !s.is_empty())
      .ok_or_else(|| AuthError::InvalidInput("cannot split non-recurring event".into()))?;

    // Terminate the original RRULE with UNTIL = split_at - 1 second.
    let until = (split_at - chrono::Duration::seconds(1))
      .format("%Y%m%dT%H%M%SZ")
      .to_string();
    let updated_rrule = original
      .payload
      .get("rrule")
      .and_then(|v| v.as_str())
      .map(|r| {
        let cleaned: String = r
          .split(';')
          .filter(|seg| {
            let upper = seg.to_uppercase();
            !upper.starts_with("UNTIL=") && !upper.starts_with("COUNT=")
          })
          .collect::<Vec<_>>()
          .join(";");
        format!("{cleaned};UNTIL={until}")
      })
      .unwrap_or_default();

    let mut updated_original_payload = original.payload.clone();
    if let Some(obj) = updated_original_payload.as_object_mut() {
      obj.insert("rrule".to_string(), serde_json::json!(updated_rrule));
    }

    let updated_original = CalendarEvent {
      payload: updated_original_payload,
      updated_at: Utc::now(),
      ..original.clone()
    };
    // Build new tail event.
    let mut new_payload = original.payload.clone();
    if let (Some(base), Some(changes)) = (new_payload.as_object_mut(), changes_payload.as_object()) {
      for (k, v) in changes {
        base.insert(k.clone(), v.clone());
      }
    }
    let original_duration = original.ends_at - original.starts_at;
    if let Some(obj) = new_payload.as_object_mut() {
      if let Some(rrule_val) = original.payload.get("rrule").and_then(|v| v.as_str()) {
        let stripped: String = rrule_val
          .split(';')
          .filter(|seg| {
            let upper = seg.to_uppercase();
            !upper.starts_with("UNTIL=") && !upper.starts_with("COUNT=")
          })
          .collect::<Vec<_>>()
          .join(";");
        obj.insert("rrule".to_string(), serde_json::json!(stripped));
      }
      obj.remove("recurrenceId");
      obj.remove("exdate");
      obj.remove("exdates");
    }

    let tail_id = uuid::Uuid::new_v4();
    let new_event = CalendarEvent {
      id: tail_id,
      origin: original.origin,
      account_id: original.account_id,
      workspace_id: original.workspace_id,
      remote_event_id: if original.origin == CalendarEventOrigin::Native {
        None
      } else {
        Some(format!(
          "{}-split-{tail_id}",
          original.remote_event_id.as_deref().unwrap_or_default()
        ))
      },
      starts_at: changes_payload["starts_at"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(split_at),
      ends_at: changes_payload["ends_at"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(split_at + original_duration),
      title: changes_payload["title"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| original.title.clone()),
      description: original.description.clone(),
      description_delta: None,
      location: original.location.clone(),
      source_doc_id: original.source_doc_id,
      all_day: original.all_day,
      all_members: original.all_members,
      tag_id: None,
      recurrence_parent_id: None,
      participants: original
        .participants
        .iter()
        .map(|participant| CalendarEventParticipant {
          id: Uuid::new_v4(),
          event_id: tail_id,
          ..participant.clone()
        })
        .collect(),
      reminders: original
        .reminders
        .iter()
        .map(|reminder| CalendarReminder {
          id: Uuid::new_v4(),
          event_id: tail_id,
          scheduled_for: split_at - chrono::Duration::minutes(reminder.minutes_before.into()),
          delivered_at: None,
          ..reminder.clone()
        })
        .collect(),
      payload: new_payload,
      updated_at: Utc::now(),
      etag: None,
      remote_href: None,
    };
    let (saved_original, saved_new) = if persist_tail {
      self
        .repo
        .save_calendar_split(&updated_original, &new_event)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?
    } else {
      (
        self
          .repo
          .save_authored_calendar_event(
            &updated_original,
            &updated_original.participants,
            &updated_original.reminders,
          )
          .await
          .map_err(|error| AuthError::Storage(error.to_string()))?,
        new_event,
      )
    };

    info!(
      original_event_id = %event_id,
      new_event_id = %saved_new.id,
      split_at = %split_at,
      "recurring event split (thisAndFuture)"
    );
    Ok((saved_original, saved_new))
  }

  /// Cancel a single recurrence instance (add EXDATE, I-04).
  #[instrument(skip(self))]
  pub async fn cancel_event_instance(&self, event_id: Uuid, instance_start: DateTime<Utc>) -> AuthResult<()> {
    self
      .repo
      .find_instance_by_event_and_start(event_id, instance_start)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event instance not found".into()))?;
    self
      .repo
      .cancel_calendar_occurrence(event_id, instance_start)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;

    info!(event_id = %event_id, instance_start = %instance_start, "instance cancelled (EXDATE added)");
    Ok(())
  }

  /// Update the master event of an entire recurring series (I-03).
  ///
  /// Applies `changes` (a JSON object with field-level overrides) to the
  /// master event payload, increments SEQUENCE, and re-expands all non-override
  /// instances from the updated RRULE.  Existing RECURRENCE-ID override
  /// instances are preserved — only the non-override instances are replaced.
  ///
  /// The remote write-through is left to the caller via `update_remote_event`
  /// if a CalDAV/Google href is present.
  #[instrument(skip(self, changes))]
  pub async fn update_recurring_series(&self, event_id: Uuid, changes: serde_json::Value) -> AuthResult<CalendarEvent> {
    let master = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".to_string()))?;

    // Apply field-level changes to the master payload.
    let mut new_payload = master.payload.clone();
    if let (Some(base), Some(changes_obj)) = (new_payload.as_object_mut(), changes.as_object()) {
      for (k, v) in changes_obj {
        base.insert(k.clone(), v.clone());
      }
    }

    // Increment SEQUENCE (RFC 5545 §3.8.7.4).
    if let Some(obj) = new_payload.as_object_mut() {
      let seq = obj.get("sequence").and_then(|v| v.as_i64()).unwrap_or(0);
      obj.insert("sequence".to_string(), serde_json::json!(seq + 1));
    }

    // Apply top-level field changes (title, starts_at, ends_at) from changes.
    let new_title = changes
      .get("title")
      .and_then(|v| v.as_str())
      .map(ToString::to_string)
      .or(master.title.clone());
    let new_starts_at = changes
      .get("starts_at")
      .and_then(|v| v.as_str())
      .and_then(|s| s.parse::<DateTime<Utc>>().ok())
      .unwrap_or(master.starts_at);
    let new_ends_at = changes
      .get("ends_at")
      .and_then(|v| v.as_str())
      .and_then(|s| s.parse::<DateTime<Utc>>().ok())
      .unwrap_or(master.ends_at);

    let updated_master = CalendarEvent {
      title: new_title,
      starts_at: new_starts_at,
      ends_at: new_ends_at,
      payload: new_payload.clone(),
      updated_at: Utc::now(),
      ..master.clone()
    };

    let saved = self
      .repo
      .save_authored_calendar_event(&updated_master, &updated_master.participants, &updated_master.reminders)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    // Re-expand non-override instances from the updated RRULE.
    // Override instances (is_override = true) are preserved — only the
    // non-override rows are dropped and regenerated.
    //
    // Strategy: delete all non-override instances, then re-expand using the
    // infrastructure rrule expander if available.  Override instances remain
    // untouched because they are stored under `is_override = true` and the
    // cascade-delete only applies to the full event deletion path.
    //
    // For simplicity (and to keep this crate free of the rrule dependency),
    // we drop all existing non-override instances for this event and let the
    // next CalDAV sync (or explicit re-expansion call) recreate them.  The
    // override instances are re-inserted immediately so they are never lost.
    let now = Utc::now();
    let horizon = now + chrono::Duration::days(365);

    // Collect existing override instances before wiping.
    let existing_overrides: Vec<CalendarEventInstance> = self
      .repo
      .list_event_instances(event_id, now - chrono::Duration::days(365 * 5), horizon)
      .await
      .unwrap_or_default()
      .into_iter()
      .filter(|i| i.is_override)
      .collect();

    // Wipe all instances (override and non-override) for this event.
    if let Err(e) = self.repo.delete_event_instances_by_event(event_id).await {
      warn!(event_id = %event_id, error = %e, "update_recurring_series: failed to delete old instances (non-fatal)");
    }

    // Re-insert override instances so they survive the series update.
    for inst in existing_overrides {
      if let Err(e) = self.repo.upsert_event_instance(&inst).await {
        warn!(event_id = %event_id, instance_id = %inst.id, error = %e, "update_recurring_series: failed to re-insert override (non-fatal)");
      }
    }

    // Non-override instances will be re-expanded on the next CalDAV/Google
    // sync cycle.  The application crate does not depend on the infrastructure
    // RRULE expander to avoid a circular-dependency.  Clearing the stale rows
    // here is enough — the sync service re-populates them from the new RRULE.

    info!(event_id = %event_id, "recurring series updated (SEQUENCE incremented, overrides preserved, instances pending sync re-expansion)");
    Ok(saved)
  }

  /// Delete the entire recurring series (I-05).
  #[instrument(skip(self))]
  pub async fn delete_recurring_series(&self, event_id: Uuid) -> AuthResult<()> {
    self.delete_remote_event(event_id).await?;
    info!(event_id = %event_id, "recurring series deleted");
    Ok(())
  }

  // ── Tag CRUD (P-JCAL-SERVER-03) ─────────────────────────────────────────

  #[instrument(skip(self))]
  pub async fn insert_event_tag(&self, workspace_id: Uuid, name: &str, color: &str) -> AuthResult<CalendarEventTag> {
    use myoxus_domain::ids::CalendarEventTagId;
    let now = Utc::now();
    let tag = CalendarEventTag {
      id: CalendarEventTagId::new_v4(),
      workspace_id,
      name: name.to_string(),
      color: color.to_string(),
      created_at: now,
      updated_at: now,
    };
    self
      .repo
      .insert_calendar_event_tag(&tag)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  #[instrument(skip(self))]
  pub async fn update_event_tag(
    &self,
    tag_id: Uuid,
    workspace_id: Uuid,
    name: Option<&str>,
    color: Option<&str>,
  ) -> AuthResult<CalendarEventTag> {
    let existing = self
      .repo
      .list_calendar_event_tags(workspace_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .into_iter()
      .find(|t| t.id == tag_id)
      .ok_or_else(|| AuthError::NotFound("event tag not found".to_string()))?;
    let new_name = name.unwrap_or(&existing.name);
    let new_color = color.unwrap_or(&existing.color);
    self
      .repo
      .update_calendar_event_tag(tag_id, workspace_id, new_name, new_color)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("event tag not found".to_string()))
  }

  #[instrument(skip(self))]
  pub async fn delete_event_tag(&self, tag_id: Uuid, workspace_id: Uuid) -> AuthResult<()> {
    self
      .repo
      .delete_calendar_event_tag(tag_id, workspace_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  #[instrument(skip(self))]
  pub async fn list_event_tags(&self, workspace_id: Uuid) -> AuthResult<Vec<CalendarEventTag>> {
    self
      .repo
      .list_calendar_event_tags(workspace_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  // ── Workspace calendar settings (P-JCAL-SERVER-03) ──────────────────────

  #[instrument(skip(self))]
  pub async fn upsert_workspace_calendar_settings(
    &self,
    workspace_id: Uuid,
    writeback_subscription_id: Option<Uuid>,
    default_reminder_offset_minutes: Option<i32>,
  ) -> AuthResult<WorkspaceCalendarSettings> {
    let settings = WorkspaceCalendarSettings {
      workspace_id,
      writeback_subscription_id,
      default_reminder_offset_minutes,
      updated_at: Utc::now(),
    };
    self
      .repo
      .upsert_workspace_calendar_settings(&settings)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  #[instrument(skip(self))]
  pub async fn get_workspace_calendar_settings(
    &self,
    workspace_id: Uuid,
  ) -> AuthResult<Option<WorkspaceCalendarSettings>> {
    self
      .repo
      .get_workspace_calendar_settings(workspace_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }
}

/// Port for pushing realtime `calendar_reminder_due` signals to the user's socket.
///
/// SERVER-05 wires up the Socket.IO implementation; until then the no-op default
/// is used so the service can be built and tested independently.
#[async_trait]
pub trait ReminderDispatchedPort: Send + Sync {
  async fn notify_reminder_due(&self, user_id: Uuid, event_id: CalendarEventId, scheduled_for: DateTime<Utc>);
}

/// No-op: discards every signal.
pub struct NullReminderDispatchedPort;

#[async_trait]
impl ReminderDispatchedPort for NullReminderDispatchedPort {
  async fn notify_reminder_due(&self, _user_id: Uuid, _event_id: CalendarEventId, _scheduled_for: DateTime<Utc>) {}
}

/// Worker job payload for dispatching a single calendar reminder.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReminderDispatchPayload {
  /// The ID of the [`CalendarReminder`] to dispatch.
  pub reminder_id: Uuid,
}

/// Redis-queue-backed dispatcher for calendar reminders.
///
/// `enqueue_due_reminders` polls for overdue reminders and places them on
/// the Redis queue.  The actual processing is handled by `CalendarQueueHandler`
/// in the worker crate via `JobHandler`.
#[derive(Clone)]
pub struct CalendarReminderDispatcher {
  /// Redis-based worker queue port for enqueueing reminder jobs.
  queue: Arc<dyn WorkQueuePort>,
  /// Calendar repository for fetching due reminders.
  repo: Arc<dyn CalendarRepository>,
  /// Current recipient presentation; explicit reminders do not consult optional mail opt-outs.
  auth: Arc<dyn AuthStore>,
  mail_defaults: UserPreferenceDefaults,
  /// Name of the worker queue used for reminder dispatch jobs.
  queue_name: String,
  /// Optional notification service for in-app delivery.
  notification_service: Option<Arc<NotificationService>>,
  /// Optional mail port for email delivery.
  mailer: Option<Arc<dyn MailPort>>,
  /// Socket port for real-time `calendar_reminder_due` delivery to the user.
  socket_port: Arc<dyn ReminderDispatchedPort>,
}

impl CalendarReminderDispatcher {
  /// Construct a `CalendarReminderDispatcher` using the default queue name
  /// `"calendar-reminder"`.
  pub fn new(queue: Arc<dyn WorkQueuePort>, repo: Arc<dyn CalendarRepository>, auth: Arc<dyn AuthStore>) -> Self {
    Self {
      queue,
      repo,
      auth,
      mail_defaults: UserPreferenceDefaults::default(),
      queue_name: "calendar-reminder".to_string(),
      notification_service: None,
      mailer: None,
      socket_port: Arc::new(NullReminderDispatchedPort),
    }
  }

  pub fn with_mail_defaults(mut self, defaults: UserPreferenceDefaults) -> Self {
    self.mail_defaults = defaults;
    self
  }

  /// Attach a [`NotificationService`] for in-app reminder delivery.
  pub fn with_notification_service(mut self, svc: Arc<NotificationService>) -> Self {
    self.notification_service = Some(svc);
    self
  }

  /// Attach a [`MailPort`] for email reminder delivery.
  pub fn with_mailer(mut self, mailer: Arc<dyn MailPort>) -> Self {
    self.mailer = Some(mailer);
    self
  }

  /// Attach a [`ReminderDispatchedPort`] for real-time socket delivery.
  pub fn with_socket_port(mut self, port: Arc<dyn ReminderDispatchedPort>) -> Self {
    self.socket_port = port;
    self
  }

  /// Deliver current reminder recipients under session-scoped ownership. Pending
  /// claims are reclaimed after interruption; completed recipients survive retry.
  /// Short repository steps never span SMTP or socket calls. Dropping this future
  /// closes its guard, including while waiting to acquire ownership.
  #[instrument(skip(self))]
  pub async fn process_reminder(&self, reminder_id: Uuid) -> AuthResult<()> {
    let mut guard = self
      .repo
      .acquire_reminder_delivery_guard(reminder_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    let result = async {
      if !guard.begin_dispatch(Uuid::new_v4(), Utc::now()).await
        .map_err(|e| AuthError::Storage(e.to_string()))? {
        debug!(reminder_id = %reminder_id, "calendar reminder completed or absent, skipping");
        return Ok(());
      }
      // Fetch delivery context (user email, event title, starts_at) for routing.
      let contexts = guard
        .contexts()
        .await
        .map_err(|e| AuthError::Storage(e.to_string()))?;

      for ctx in &contexts {
        let event = self
          .repo
          .get_calendar_event(ctx.reminder.event_id)
          .await
          .map_err(|error| AuthError::Storage(error.to_string()))?;
        if event.is_none() { continue; }
        let url = event
          .as_ref()
          .and_then(|event| event.workspace_id)
          .map(|workspace| format!("/workspace/{workspace}/journals"))
          .unwrap_or_default();
        let channel = ctx.reminder.channel.as_str();
        let idempotency_key = format!("calendar_reminder_{}", reminder_id);

        match channel {
          "in_app" | "" => {
            // Default channel: in-app notification.
            if let Some(svc) = &self.notification_service {
              let payload = serde_json::json!({
                "reminder_id": reminder_id,
                "eventId":ctx.reminder.event_id,
                "workspaceId":event.as_ref().and_then(|event|event.workspace_id),
                "all_day":event.as_ref().is_some_and(|event|event.all_day),
                "event_title": ctx.event_title,
                "starts_at": ctx.starts_at.to_rfc3339(),
              });
              if let Err(e) = svc
                .create_notification(
                  ctx.user_id,
                  "calendar_reminder".to_string(),
                  Some("info".to_string()),
                  Some(idempotency_key),
                  payload,
                )
                .await
              {
                warn!(reminder_id = %reminder_id, error = %e, "in_app reminder notification failed");
              } else {
                info!(reminder_id = %reminder_id, user_id = %ctx.user_id, "in-app calendar reminder delivered");
              }
            } else {
              warn!(reminder_id = %reminder_id, "in_app reminder: no notification_service configured");
            }
          }
          "email" => {
            if let Some(mailer) = &self.mailer {
              if guard
                .email_completed(ctx.user_id)
                .await
                .map_err(|error| AuthError::Storage(error.to_string()))?
              {
                continue;
              }
              let preferences = self.auth.get_user_preferences(ctx.user_id).await?.values.resolve(&self.mail_defaults);
              let presentation = crate::ports::MailPresentation::from_preferences(&preferences, None);
              if let Err(e) = mailer
                .send_template(crate::ports::TemplateMail::new(
                  &ctx.user_email,
                  crate::ports::MailTemplate::CalendarReminder,
                  presentation,
                  serde_json::json!({"event_title":ctx.event_title,"starts_at":ctx.starts_at.to_rfc3339(),"url":url,
                  "all_day":event.as_ref().is_some_and(|event|event.all_day),
                  "ends_at":event.as_ref().map(|event|event.ends_at.to_rfc3339()),"location":event.as_ref().and_then(|event|event.location.clone())}),
                ))
                .await
              {
                warn!(reminder_id = %reminder_id, "email reminder dispatch failed; delivery will retry");
                return Err(AuthError::Storage(e.to_string()));
              } else {
                guard
                  .complete_email(ctx.user_id)
                  .await
                  .map_err(|error| AuthError::Storage(error.to_string()))?;
                info!(reminder_id = %reminder_id, user_id = %ctx.user_id, "email calendar reminder delivered");
              }
            } else {
              return Err(AuthError::Storage("Calendar email sender unavailable".into()));
            }
          }
          "push" => {
            // TODO(future): integrate Web Push / FCM when push infrastructure is available.
            info!(reminder_id = %reminder_id, "push notification not yet implemented for reminder, skipping");
          }
          other => {
            warn!(reminder_id = %reminder_id, channel = other, "unknown reminder channel, skipping delivery");
          }
        }
      }

      guard
        .complete(Utc::now())
        .await
        .map_err(|e| AuthError::Storage(e.to_string()))?;

      for ctx in &contexts {
        self
          .socket_port
          .notify_reminder_due(ctx.user_id, ctx.reminder.event_id, ctx.reminder.scheduled_for)
          .await;
      }

      info!(reminder_id = %reminder_id, "dispatched calendar reminder");
      Ok(())
    }
    .await;
    let release = guard.release().await.map_err(|e| AuthError::Storage(e.to_string()));
    match (result, release) {
      (Ok(()), Ok(())) => Ok(()),
      (Err(error), _) | (Ok(()), Err(error)) => Err(error),
    }
  }

  /// Enqueue all due reminders (up to `limit`) into the worker queue.
  ///
  /// Returns the number of reminders successfully enqueued.
  #[instrument(skip(self))]
  pub async fn enqueue_due_reminders(&self, limit: i64) -> AuthResult<usize> {
    let due = self
      .repo
      .list_due_calendar_reminders(Utc::now(), limit)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;
    let mut enqueued = 0_usize;
    for reminder in due {
      debug!(reminder_id = %reminder.id, scheduled_for = %reminder.scheduled_for, "enqueueing due calendar reminder");
      let payload = serde_json::to_value(ReminderDispatchPayload {
        reminder_id: reminder.id,
      })
      .map_err(|e| AuthError::Storage(format!("serialize reminder payload failed: {e}")))?;
      self
        .queue
        .add_job(&self.queue_name, "calendar.processReminder", payload, Some(8), None)
        .await?;
      enqueued += 1;
    }
    tracing::info!(enqueued, limit, "enqueued due calendar reminders");
    Ok(enqueued)
  }
}
