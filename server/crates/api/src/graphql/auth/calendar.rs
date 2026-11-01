//! GraphQL calendar resolvers: event listing, reminder acknowledgement, and
//! Google Calendar webhook subscription management.
//!
//! Exposes calendar functionality under the authenticated GraphQL surface:
//! `CalendarQuery` (sub-object on `AuthQuery`) and `CalendarMutation`
//! (sub-object on `AuthMutation`).

use async_graphql::{Context, Enum, ID, InputObject, Json, MaybeUndefined, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::instrument;
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;
use myoxus_application::auth::AuthError;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_domain::permission::WorkspaceAction;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "CalendarProviderType")]
pub enum CalendarProviderType {
  #[graphql(name = "CalDAV")]
  CalDav,
  #[graphql(name = "Google")]
  Google,
}

#[derive(SimpleObject, Clone, Serialize, Deserialize)]
#[graphql(name = "CalendarCalDAVProviderPresetObjectType")]
pub struct CalendarCalDAVProviderPresetObjectType {
  pub id: String,
  pub label: String,
  pub requires_app_password: Option<bool>,
  pub docs_url: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarSubscriptionObjectType")]
pub struct CalendarSubscriptionObjectType {
  pub id: String,
  pub account_id: String,
  pub provider: CalendarProviderType,
  pub external_calendar_id: String,
  pub display_name: Option<String>,
  pub timezone: Option<String>,
  pub color: Option<String>,
  pub enabled: bool,
  pub last_sync_at: Option<DateTime<Utc>>,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarAccountType")]
pub struct CalendarAccountType {
  pub id: ID,
  pub user_id: ID,
  pub provider: String,
  pub remote_account_id: String,
  pub expires_at: Option<DateTime<Utc>>,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarAccountObjectType")]
pub struct CalendarAccountObjectType {
  pub id: String,
  pub provider: CalendarProviderType,
  pub provider_account_id: String,
  pub display_name: Option<String>,
  pub email: Option<String>,
  pub status: String,
  pub last_error: Option<String>,
  pub refresh_interval_minutes: i32,
  pub calendars_count: i32,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
  pub calendars: Vec<CalendarSubscriptionObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceCalendarType")]
pub struct WorkspaceCalendarType {
  pub workspace_id: ID,
  pub account_id: ID,
  pub remote_calendar_id: String,
  pub enabled: bool,
  pub updated_at: DateTime<Utc>,
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceCalendarItemObjectType")]
pub struct WorkspaceCalendarItemObjectType {
  pub id: String,
  pub subscription_id: String,
  pub sort_order: Option<i32>,
  pub color_override: Option<String>,
  pub enabled: bool,
}

pub struct WorkspaceCalendarObjectType {
  pub id: String,
  pub workspace_id: String,
  pub created_by_user_id: String,
  pub display_name_override: Option<String>,
  pub color_override: Option<String>,
  pub enabled: bool,
  pub items: Vec<WorkspaceCalendarItemObjectType>,
  pub account_id: String,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarEventParticipantType")]
pub struct CalendarEventParticipantType {
  pub id: ID,
  pub user_id: Option<ID>,
  pub email: String,
  pub display_name: Option<String>,
  pub response_status: String,
  pub is_organizer: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarReminderType")]
pub struct CalendarReminderType {
  pub id: ID,
  pub channel: String,
  pub minutes_before: i32,
  pub scheduled_for: DateTime<Utc>,
  pub delivered_at: Option<DateTime<Utc>>,
}

/// A materialized recurrence instance of a calendar event (P90-CAL-C-05).
///
/// Each row represents one concrete occurrence of a recurring event.
/// Override instances (RECURRENCE-ID exceptions) carry field-level overrides
/// in `title`, `description`, and `location`.
#[derive(SimpleObject)]
#[graphql(name = "CalendarEventInstanceType")]
pub struct CalendarEventInstanceType {
  pub id: ID,
  pub event_id: ID,
  pub instance_start: DateTime<Utc>,
  pub instance_end: DateTime<Utc>,
  pub is_override: bool,
  pub is_cancelled: bool,
  /// Title from override_payload if present, otherwise from the parent event.
  pub title: Option<String>,
  /// Description from override_payload if present, otherwise from the parent event.
  pub description: Option<String>,
  /// Location from override_payload if present, otherwise from the parent event.
  pub location: Option<String>,
}

/// A user-facing calendar event (created via GraphQL upsert or synced from a
/// remote provider).
///
/// The `instances` field exposes materialized recurrence occurrences for
/// recurring events (P90-CAL-C-05).
pub struct CalendarEventType {
  pub id: ID,
  pub origin: CalendarEventOriginGql,
  pub account_id: ID,
  pub workspace_id: Option<ID>,
  pub remote_event_id: String,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub title: Option<String>,
  pub source_external_id: Option<ID>,
  pub all_day: bool,
  pub all_members: bool,
  pub tag_id: Option<ID>,
  pub description_delta: Option<Value>,
  pub recurrence_parent_id: Option<ID>,
  pub participants: Vec<CalendarEventParticipantType>,
  pub reminders: Vec<CalendarReminderType>,
}

#[Object(name = "CalendarEventType")]
impl CalendarEventType {
  async fn id(&self) -> &ID {
    &self.id
  }
  async fn origin(&self) -> CalendarEventOriginGql {
    self.origin
  }
  async fn account_id(&self) -> &ID {
    &self.account_id
  }
  async fn workspace_id(&self) -> &Option<ID> {
    &self.workspace_id
  }
  async fn remote_event_id(&self) -> &str {
    &self.remote_event_id
  }
  async fn starts_at(&self) -> DateTime<Utc> {
    self.starts_at
  }
  async fn ends_at(&self) -> DateTime<Utc> {
    self.ends_at
  }
  async fn title(&self) -> &Option<String> {
    &self.title
  }
  async fn source_external_id(&self) -> &Option<ID> {
    &self.source_external_id
  }
  /// Deprecated same-value alias for `sourceExternalId`.
  #[graphql(deprecation = "use sourceExternalId")]
  async fn source_doc_id(&self) -> &Option<ID> {
    &self.source_external_id
  }
  async fn all_day(&self) -> bool {
    self.all_day
  }
  async fn all_members(&self) -> bool {
    self.all_members
  }
  async fn tag_id(&self) -> &Option<ID> {
    &self.tag_id
  }
  async fn description_delta(&self) -> Option<Json<Value>> {
    self.description_delta.clone().map(Json)
  }
  async fn recurrence_parent_id(&self) -> &Option<ID> {
    &self.recurrence_parent_id
  }
  async fn participants(&self) -> &[CalendarEventParticipantType] {
    &self.participants
  }
  async fn reminders(&self) -> &[CalendarReminderType] {
    &self.reminders
  }

  /// List materialized recurrence instances within `[from, to)`.
  ///
  /// For non-recurring events this returns an empty list.
  /// Override instances (RECURRENCE-ID exceptions) carry overridden
  /// title/description/location from the provider.
  #[instrument(skip(self, ctx))]
  async fn instances(
    &self,
    ctx: &Context<'_>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<Vec<CalendarEventInstanceType>> {
    if to < from {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid time range: `to` must be >= `from`".to_string(),
      )));
    }
    let event_id = Uuid::parse_str(self.id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;
    let (state, _snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let instances = calendar
      .list_event_instances(event_id, from, to)
      .await
      .map_err(map_gql_error)?;

    Ok(
      instances
        .into_iter()
        .map(|inst| {
          // Merge override_payload fields over the event-level defaults.
          let override_title = inst
            .override_payload
            .as_ref()
            .and_then(|p| p.get("title"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
          let override_description = inst
            .override_payload
            .as_ref()
            .and_then(|p| p.get("description"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
          let override_location = inst
            .override_payload
            .as_ref()
            .and_then(|p| p.get("location"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
          CalendarEventInstanceType {
            id: ID::from(inst.id.to_string()),
            event_id: ID::from(inst.event_id.to_string()),
            instance_start: inst.instance_start,
            instance_end: inst.instance_end,
            is_override: inst.is_override,
            is_cancelled: inst.is_cancelled,
            title: override_title.or_else(|| self.title.clone()),
            description: override_description,
            location: override_location,
          }
        })
        .collect(),
    )
  }
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarEventObjectType")]
pub struct CalendarEventObjectType {
  pub id: String,
  pub subscription_id: String,
  pub external_event_id: String,
  pub recurrence_id: Option<String>,
  pub status: Option<String>,
  pub title: Option<String>,
  pub description: Option<String>,
  pub location: Option<String>,
  pub start_at_utc: DateTime<Utc>,
  pub end_at_utc: DateTime<Utc>,
  pub original_timezone: Option<String>,
  pub all_day: bool,
  pub tag_id: Option<String>,
  pub reminders: Vec<CalendarReminderType>,
}

#[derive(InputObject)]
#[graphql(name = "CalendarParticipantInput")]
pub struct CalendarParticipantInput {
  pub user_id: Option<String>,
  pub email: String,
  pub display_name: Option<String>,
  pub response_status: Option<String>,
  pub is_organizer: Option<bool>,
}

#[derive(InputObject)]
#[graphql(name = "CalendarReminderInput")]
pub struct CalendarReminderInput {
  pub channel: Option<String>,
  pub minutes_before: i32,
  pub scheduled_for: DateTime<Utc>,
}

#[derive(InputObject)]
#[graphql(name = "CalendarEventInput")]
pub struct CalendarEventInput {
  pub id: Option<String>,
  pub account_id: String,
  pub workspace_id: String,
  pub remote_event_id: String,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub title: Option<String>,
  pub source_external_id: MaybeUndefined<Option<String>>,
  /// Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key.
  pub source_doc_id: MaybeUndefined<Option<String>>,
  pub participants: Vec<CalendarParticipantInput>,
  pub reminders: Vec<CalendarReminderInput>,
}

#[derive(InputObject)]
#[graphql(name = "UpdateCalendarAccountInput")]
pub struct UpdateCalendarAccountInput {
  pub account_id: String,
  pub expires_at: Option<DateTime<Utc>>,
  pub config: Option<serde_json::Value>,
}

#[derive(InputObject)]
#[graphql(name = "LinkCalendarAccountInput")]
pub struct LinkCalendarAccountInput {
  pub provider: CalendarProviderType,
  pub redirect_uri: Option<String>,
}

#[derive(InputObject)]
#[graphql(name = "LinkCalDAVAccountInput")]
pub struct LinkCalDAVAccountInput {
  pub provider_preset_id: String,
  pub username: String,
  pub password: String,
  pub display_name: Option<String>,
}

#[derive(InputObject)]
#[graphql(name = "WorkspaceCalendarInput")]
pub struct WorkspaceCalendarInput {
  pub account_id: String,
  pub remote_calendar_id: String,
  pub enabled: bool,
}

#[derive(InputObject)]
#[graphql(name = "WorkspaceCalendarItemInput")]
pub struct WorkspaceCalendarItemInput {
  pub subscription_id: String,
  pub sort_order: Option<i32>,
  pub color_override: Option<String>,
}

#[derive(InputObject)]
#[graphql(name = "UpdateWorkspaceCalendarsInput")]
pub struct UpdateWorkspaceCalendarsInput {
  pub workspace_id: String,
  pub items: Vec<WorkspaceCalendarItemInput>,
}

#[derive(SimpleObject)]
#[graphql(name = "CalendarReminderStatusResult")]
pub struct CalendarReminderStatusResult {
  pub ok: bool,
}

/// GraphQL representation of a calendar conflict (P90-CAL-F-04).
#[derive(SimpleObject)]
#[graphql(name = "CalendarConflictType")]
pub struct CalendarConflictType {
  /// Local event ID.
  pub event_id: ID,
  /// The local version of the event.
  pub local_version: CalendarEventType,
  /// The current remote version of the event.
  pub remote_version: CalendarEventType,
  /// Names of the fields that conflict.
  pub conflicting_fields: Vec<String>,
}

/// Resolution strategy for a calendar conflict.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "ConflictResolution", rename_items = "PascalCase")]
pub enum ConflictResolution {
  /// Overwrite the remote with our local version.
  KeepLocal,
  /// Discard our local changes and use the remote version.
  KeepRemote,
  /// Attempt an automatic three-way merge.
  MergeAuto,
}

/// Scope of a recurring-event edit or delete operation (P90-CAL-I-05).
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "InstanceEditScope", rename_items = "PascalCase")]
pub enum InstanceEditScope {
  /// Modify only this single occurrence (RECURRENCE-ID exception).
  ThisOnly,
  /// Modify this occurrence and all future occurrences (thisAndFuture split).
  ThisAndFuture,
  /// Modify all occurrences — redirect to the regular series update/delete.
  All,
}

// ── Native-event GQL types (P-JCAL-SERVER-03) ────────────────────────────────

/// Origin discriminator for a calendar event.
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "CalendarEventOrigin", rename_items = "PascalCase")]
pub enum CalendarEventOriginGql {
  Native,
  External,
}

/// A user-defined label assignable to native calendar events.
#[derive(SimpleObject)]
#[graphql(name = "CalendarEventTagType")]
pub struct CalendarEventTagType {
  pub id: ID,
  pub workspace_id: ID,
  pub name: String,
  pub color: String,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

/// Per-workspace calendar configuration (writeback target, default reminder).
#[derive(SimpleObject)]
#[graphql(name = "WorkspaceCalendarSettingsType")]
pub struct WorkspaceCalendarSettingsType {
  pub workspace_id: ID,
  pub writeback_subscription_id: Option<String>,
  pub default_reminder_offset_minutes: Option<i32>,
  pub updated_at: DateTime<Utc>,
}

/// Result of `importWorkspaceCalendarIcs` (P-JCAL-SERVER-07-B).
#[derive(SimpleObject)]
#[graphql(name = "CalendarIcsImportResult")]
pub struct CalendarIcsImportResult {
  /// Number of VEVENTs successfully imported as native events.
  pub imported_count: i32,
  /// Number of VEVENTs skipped due to validation or parse errors.
  pub skipped_count: i32,
  /// Per-event error messages for skipped events.
  pub errors: Vec<String>,
}

// ── Input types ────────────────────────────────────────────────────────────

/// Reminder attached to a native calendar event during creation.
#[derive(InputObject)]
#[graphql(name = "NativeReminderInput")]
pub struct NativeReminderInput {
  pub minutes_before: i32,
  /// "in_app" (default), "email", or "push". Email reminders use the configured
  /// localized mail catalog independently of optional notification emails.
  pub channel: Option<String>,
}

/// Scope for a recurring-event mutation (v1 supports All and This only).
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "NativeEventScope", rename_items = "PascalCase")]
pub enum NativeEventScope {
  /// Edit / delete the master event and all occurrences.
  All,
  /// Edit / delete only a single occurrence (creates an EXDATE + override row).
  This,
}

/// Input for creating a workspace-native calendar event.
#[derive(InputObject)]
#[graphql(name = "CreateWorkspaceEventInput")]
pub struct CreateWorkspaceEventInput {
  pub workspace_id: String,
  pub title: Option<String>,
  pub description_delta: Option<Json<Value>>,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub all_day: Option<bool>,
  pub all_members: Option<bool>,
  pub tag_id: Option<String>,
  pub source_external_id: MaybeUndefined<Option<String>>,
  /// Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key.
  pub source_doc_id: MaybeUndefined<Option<String>>,
  pub source_block_id: Option<String>,
  pub source_start_offset: Option<i32>,
  pub source_end_offset: Option<i32>,
  pub source_kind: Option<String>,
  pub reminders: Option<Vec<NativeReminderInput>>,
}

/// Input for updating a workspace-native calendar event.
#[derive(InputObject)]
#[graphql(name = "UpdateWorkspaceEventInput")]
pub struct UpdateWorkspaceEventInput {
  pub title: Option<String>,
  pub description_delta: Option<Json<Value>>,
  pub starts_at: Option<DateTime<Utc>>,
  pub ends_at: Option<DateTime<Utc>>,
  pub all_day: Option<bool>,
  pub all_members: Option<bool>,
  /// Pass `null` to clear the tag; omit to leave unchanged.
  pub tag_id: MaybeUndefined<Option<String>>,
  /// Pass `null` to unlink the source doc; omit to leave unchanged.
  pub source_external_id: MaybeUndefined<Option<String>>,
  /// Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key.
  pub source_doc_id: MaybeUndefined<Option<String>>,
  pub source_block_id: MaybeUndefined<Option<String>>,
  pub source_start_offset: MaybeUndefined<Option<i32>>,
  pub source_end_offset: MaybeUndefined<Option<i32>>,
  pub source_kind: MaybeUndefined<Option<String>>,
  /// Omit to leave reminders unchanged; pass `null` or an empty list to clear
  /// them; pass a list to replace the complete reminder set atomically.
  pub reminders: MaybeUndefined<Option<Vec<NativeReminderInput>>>,
}

/// Input for creating a workspace event tag.
#[derive(InputObject)]
#[graphql(name = "CreateEventTagInput")]
pub struct CreateEventTagInput {
  pub workspace_id: String,
  pub name: String,
  pub color: String,
}

/// Input for updating an existing workspace event tag.
#[derive(InputObject)]
#[graphql(name = "UpdateEventTagInput")]
pub struct UpdateEventTagInput {
  pub workspace_id: String,
  pub name: Option<String>,
  pub color: Option<String>,
}

/// Input for updating workspace-level calendar settings.
#[derive(InputObject)]
#[graphql(name = "UpdateWorkspaceCalendarSettingsInput")]
pub struct UpdateWorkspaceCalendarSettingsInput {
  pub workspace_id: String,
  pub writeback_subscription_id: Option<String>,
  pub default_reminder_offset_minutes: Option<i32>,
}

/// Input for updating a single recurring event instance or splitting the series.
#[derive(InputObject)]
#[graphql(name = "UpdateCalendarEventInstanceInput")]
pub struct UpdateCalendarEventInstanceInput {
  pub event_id: ID,
  /// The original DTSTART of the instance to update (used as RECURRENCE-ID key).
  pub instance_start: DateTime<Utc>,
  /// Field-level overrides to apply.
  pub changes: serde_json::Value,
  pub scope: InstanceEditScope,
}

/// Result of `updateCalendarEventInstance`.
#[derive(SimpleObject)]
#[graphql(name = "UpdateCalendarEventInstanceResult")]
pub struct UpdateCalendarEventInstanceResult {
  pub ok: bool,
  pub instance: Option<CalendarEventInstanceType>,
}

/// RSVP status for a calendar event participant (P90-CAL-H-04).
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[graphql(name = "CalendarRsvpStatus", rename_items = "PascalCase")]
pub enum CalendarRsvpStatus {
  /// Attendee has accepted the invitation.
  Accepted,
  /// Attendee has declined the invitation.
  Declined,
  /// Attendee is tentatively accepting.
  Tentative,
  /// Attendee has not yet responded.
  NeedsAction,
}

impl From<CalendarRsvpStatus> for myoxus_application::calendar::RsvpStatus {
  fn from(v: CalendarRsvpStatus) -> Self {
    match v {
      CalendarRsvpStatus::Accepted => myoxus_application::calendar::RsvpStatus::Accepted,
      CalendarRsvpStatus::Declined => myoxus_application::calendar::RsvpStatus::Declined,
      CalendarRsvpStatus::Tentative => myoxus_application::calendar::RsvpStatus::Tentative,
      CalendarRsvpStatus::NeedsAction => myoxus_application::calendar::RsvpStatus::NeedsAction,
    }
  }
}

/// A single free/busy period (P90-CAL-H-07).
#[derive(SimpleObject, Clone)]
#[graphql(name = "CalendarFreeBusyPeriod")]
pub struct CalendarFreeBusyPeriod {
  /// Start of the busy period.
  pub start: DateTime<Utc>,
  /// End of the busy period.
  pub end: DateTime<Utc>,
}

/// Free/busy result for a single user (P90-CAL-H-07).
#[derive(SimpleObject)]
#[graphql(name = "UserFreeBusy")]
pub struct UserFreeBusy {
  /// The user ID.
  pub user_id: ID,
  /// List of busy periods within the queried window.
  pub busy_periods: Vec<CalendarFreeBusyPeriod>,
}

// --- Helper functions ---

pub(crate) fn map_calendar_provider(provider: &str) -> CalendarProviderType {
  match provider.to_ascii_lowercase().as_str() {
    "google" => CalendarProviderType::Google,
    _ => CalendarProviderType::CalDav,
  }
}

pub(crate) fn subscription_id(account_id: Uuid, remote_calendar_id: &str) -> String {
  format!("{account_id}:{remote_calendar_id}")
}

pub(crate) fn parse_subscription_id(value: &str) -> Option<(Uuid, String)> {
  let (account, remote) = value.split_once(':')?;
  let account_id = Uuid::parse_str(account).ok()?;
  if remote.is_empty() {
    return None;
  }
  Some((account_id, remote.to_string()))
}

pub(crate) fn map_calendar_account(account: myoxus_domain::entities::CalendarAccount) -> CalendarAccountType {
  CalendarAccountType {
    id: ID::from(account.id.to_string()),
    user_id: ID::from(account.user_id.to_string()),
    provider: account.provider,
    remote_account_id: account.remote_account_id,
    expires_at: account.expires_at,
  }
}

pub(crate) fn map_calendar_account_object(
  account: myoxus_domain::entities::CalendarAccount,
  subscriptions: Vec<myoxus_domain::entities::CalendarSubscription>,
) -> CalendarAccountObjectType {
  let provider = map_calendar_provider(&account.provider);
  let refresh_interval = account
    .config
    .get("refreshIntervalMinutes")
    .and_then(|v| v.as_i64())
    .unwrap_or(15)
    .clamp(1, 24 * 60) as i32;
  let status = account
    .config
    .get("status")
    .and_then(|v| v.as_str())
    .unwrap_or("connected")
    .to_string();
  let display_name = account
    .config
    .get("displayName")
    .and_then(|v| v.as_str())
    .map(ToString::to_string);
  let email = account
    .config
    .get("email")
    .and_then(|v| v.as_str())
    .map(ToString::to_string);
  let last_error = account
    .config
    .get("lastError")
    .and_then(|v| v.as_str())
    .map(ToString::to_string);
  let calendars = subscriptions
    .into_iter()
    .map(|s| CalendarSubscriptionObjectType {
      id: subscription_id(s.account_id, &s.remote_calendar_id),
      account_id: s.account_id.to_string(),
      provider,
      external_calendar_id: s.remote_calendar_id.clone(),
      display_name: None,
      timezone: None,
      color: None,
      enabled: true,
      last_sync_at: Some(s.updated_at),
    })
    .collect::<Vec<_>>();
  CalendarAccountObjectType {
    id: account.id.to_string(),
    provider,
    provider_account_id: account.remote_account_id,
    display_name,
    email,
    status,
    last_error,
    refresh_interval_minutes: refresh_interval,
    calendars_count: calendars.len() as i32,
    created_at: account.created_at,
    updated_at: account.updated_at,
    calendars,
  }
}

pub(crate) fn map_calendar_event(
  event: myoxus_domain::entities::CalendarEvent,
  source_external_id: Option<String>,
) -> CalendarEventType {
  let origin = match event.origin {
    myoxus_domain::entities::CalendarEventOrigin::Native => CalendarEventOriginGql::Native,
    myoxus_domain::entities::CalendarEventOrigin::External => CalendarEventOriginGql::External,
  };
  CalendarEventType {
    id: ID::from(event.id.to_string()),
    origin,
    account_id: ID::from(event.account_id.map(|id| id.to_string()).unwrap_or_default()),
    workspace_id: event.workspace_id.map(|id| ID::from(id.to_string())),
    remote_event_id: event.remote_event_id.unwrap_or_default(),
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    title: event.title,
    source_external_id: source_external_id.map(ID::from),
    all_day: event.all_day,
    all_members: event.all_members,
    tag_id: event.tag_id.map(|id| ID::from(id.to_string())),
    description_delta: event.description_delta,
    recurrence_parent_id: event.recurrence_parent_id.map(|id| ID::from(id.to_string())),
    participants: event
      .participants
      .into_iter()
      .map(|p| CalendarEventParticipantType {
        id: ID::from(p.id.to_string()),
        user_id: p.user_id.map(|id| ID::from(id.to_string())),
        email: p.email,
        display_name: p.display_name,
        response_status: p.response_status,
        is_organizer: p.is_organizer,
      })
      .collect(),
    reminders: event
      .reminders
      .into_iter()
      .map(|r| CalendarReminderType {
        id: ID::from(r.id.to_string()),
        channel: r.channel,
        minutes_before: r.minutes_before,
        scheduled_for: r.scheduled_for,
        delivered_at: r.delivered_at,
      })
      .collect(),
  }
}

/// Project source document keys for a workspace in one batch before mapping
/// Calendar domain events to their actor-facing GraphQL shape.
pub(crate) async fn map_calendar_events_for_workspace(
  state: &ApiState,
  workspace_id: Uuid,
  events: Vec<myoxus_domain::entities::CalendarEvent>,
) -> Result<Vec<CalendarEventType>> {
  let source_doc_ids = events
    .iter()
    .filter_map(|event| event.source_doc_id)
    .collect::<Vec<_>>();
  let external_ids = if source_doc_ids.is_empty() {
    std::collections::HashMap::new()
  } else {
    state
      .doc()
      .resolve_external_doc_ids(workspace_id, &source_doc_ids)
      .await
      .map_err(map_gql_error)?
  };
  Ok(
    events
      .into_iter()
      .map(|event| {
        let external_source_doc_id = event
          .source_doc_id
          .and_then(|doc_id| external_ids.get(&doc_id).cloned());
        map_calendar_event(event, external_source_doc_id)
      })
      .collect(),
  )
}

pub(crate) async fn map_calendar_event_for_workspace(
  state: &ApiState,
  workspace_id: Uuid,
  event: myoxus_domain::entities::CalendarEvent,
) -> Result<CalendarEventType> {
  map_calendar_events_for_workspace(state, workspace_id, vec![event])
    .await?
    .pop()
    .ok_or_else(|| map_gql_error(AuthError::Storage("calendar event projection failed".to_string())))
}

pub(crate) async fn map_calendar_event_from_owner(
  state: &ApiState,
  event: myoxus_domain::entities::CalendarEvent,
) -> Result<CalendarEventType> {
  let Some(workspace_id) = event.workspace_id else {
    return Ok(map_calendar_event(event, None));
  };
  map_calendar_event_for_workspace(state, workspace_id, event).await
}

pub(crate) fn map_calendar_event_tag(tag: myoxus_domain::entities::CalendarEventTag) -> CalendarEventTagType {
  CalendarEventTagType {
    id: ID::from(tag.id.to_string()),
    workspace_id: ID::from(tag.workspace_id.to_string()),
    name: tag.name,
    color: tag.color,
    created_at: tag.created_at,
    updated_at: tag.updated_at,
  }
}

pub(crate) fn map_workspace_calendar_settings(
  s: myoxus_domain::entities::WorkspaceCalendarSettings,
) -> WorkspaceCalendarSettingsType {
  WorkspaceCalendarSettingsType {
    workspace_id: ID::from(s.workspace_id.to_string()),
    writeback_subscription_id: s.writeback_subscription_id.map(|id| id.to_string()),
    default_reminder_offset_minutes: s.default_reminder_offset_minutes,
    updated_at: s.updated_at,
  }
}

pub(crate) fn map_calendar_event_object(event: myoxus_domain::entities::CalendarEvent) -> CalendarEventObjectType {
  CalendarEventObjectType {
    id: event.id.to_string(),
    subscription_id: event.account_id.map(|id| id.to_string()).unwrap_or_default(),
    external_event_id: event.remote_event_id.unwrap_or_default(),
    recurrence_id: event
      .payload
      .get("recurrenceId")
      .and_then(|v| v.as_str())
      .map(ToString::to_string),
    status: event
      .payload
      .get("status")
      .and_then(|v| v.as_str())
      .map(ToString::to_string),
    title: event.title,
    description: event
      .payload
      .get("description")
      .and_then(|v| v.as_str())
      .map(ToString::to_string),
    location: event
      .payload
      .get("location")
      .and_then(|v| v.as_str())
      .map(ToString::to_string),
    start_at_utc: event.starts_at,
    end_at_utc: event.ends_at,
    original_timezone: event
      .payload
      .get("originalTimezone")
      .and_then(|v| v.as_str())
      .map(ToString::to_string),
    all_day: event.all_day,
    tag_id: event.tag_id.map(|id| id.to_string()),
    reminders: event
      .reminders
      .into_iter()
      .map(|reminder| CalendarReminderType {
        id: ID::from(reminder.id.to_string()),
        channel: reminder.channel,
        minutes_before: reminder.minutes_before,
        scheduled_for: reminder.scheduled_for,
        delivered_at: reminder.delivered_at,
      })
      .collect(),
  }
}

pub(crate) fn map_workspace_calendar(value: myoxus_domain::entities::WorkspaceCalendar) -> WorkspaceCalendarType {
  WorkspaceCalendarType {
    workspace_id: ID::from(value.workspace_id.to_string()),
    account_id: ID::from(value.account_id.to_string()),
    remote_calendar_id: value.remote_calendar_id,
    enabled: value.enabled,
    updated_at: value.updated_at,
  }
}

pub(crate) fn map_workspace_calendar_object(
  value: myoxus_domain::entities::WorkspaceCalendar,
  created_by_user_id: Uuid,
) -> WorkspaceCalendarObjectType {
  let item = WorkspaceCalendarItemObjectType {
    id: subscription_id(value.account_id, &value.remote_calendar_id),
    subscription_id: subscription_id(value.account_id, &value.remote_calendar_id),
    sort_order: Some(0),
    color_override: None,
    enabled: value.enabled,
  };
  WorkspaceCalendarObjectType {
    id: subscription_id(value.account_id, &value.remote_calendar_id),
    workspace_id: value.workspace_id.to_string(),
    created_by_user_id: created_by_user_id.to_string(),
    display_name_override: None,
    color_override: None,
    enabled: value.enabled,
    items: vec![item],
    account_id: value.account_id.to_string(),
  }
}

// --- #[Object] impl WorkspaceCalendarObjectType ---

#[Object]
impl WorkspaceCalendarObjectType {
  async fn id(&self) -> &str {
    &self.id
  }
  async fn workspace_id(&self) -> &str {
    &self.workspace_id
  }
  async fn created_by_user_id(&self) -> &str {
    &self.created_by_user_id
  }
  async fn display_name_override(&self) -> Option<&str> {
    self.display_name_override.as_deref()
  }
  async fn color_override(&self) -> Option<&str> {
    self.color_override.as_deref()
  }
  async fn enabled(&self) -> bool {
    self.enabled
  }
  async fn items(&self) -> &[WorkspaceCalendarItemObjectType] {
    &self.items
  }

  #[instrument(skip(self, ctx))]
  async fn events(
    &self,
    ctx: &Context<'_>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<Vec<CalendarEventObjectType>> {
    if to < from {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid time range: `to` must be greater than or equal to `from`".to_string(),
      )));
    }
    let workspace_id = Uuid::parse_str(&self.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let account_id = Uuid::parse_str(&self.account_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid account id".to_string())))?;
    let (state, snapshot) = require_session(ctx).await?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        WorkspaceAction::SettingsRead,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let events = calendar
      .list_workspace_events(workspace_id, from, to)
      .await
      .map_err(map_gql_error)?;
    // Nil UUID is the sentinel for the virtual native workspace calendar.
    // Native events have account_id = NULL; CalDAV events filter by their account UUID.
    Ok(
      events
        .into_iter()
        .filter(|e| {
          if account_id.is_nil() {
            e.account_id.is_none()
          } else {
            e.account_id == Some(account_id)
          }
        })
        .map(map_calendar_event_object)
        .collect(),
    )
  }
}
