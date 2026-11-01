// SPDX-License-Identifier: AGPL-3.0-or-later
//! Google Calendar API v3 client — OAuth-authenticated event synchronisation.
//!
//! # Design
//!
//! This module mirrors the CalDAV sync pattern (`crate::caldav`) but targets
//! the Google Calendar REST API instead of CalDAV/PROPFIND.
//!
//! Two public components:
//!
//! * [`GoogleCalendarClient`] — thin HTTP client wrapping the Google Calendar
//!   API v3.  Handles OAuth2 token refresh, paginated `Events.list`, and
//!   incremental sync via `syncToken`.
//! * [`GoogleCalendarSyncService`] (in [`sync`]) — infrastructure-layer
//!   orchestrator that lists Google-type accounts from `CalendarRepository`,
//!   refreshes tokens, fetches events, and upserts them into PostgreSQL.
//!
//! # V1 scope
//!
//! * **Read-only** (pull). No push back to Google.
//! * **Server-Wins** conflict resolution: remote data always overwrites local.
//! * **Incremental sync** via `syncToken` (Google-native delta protocol).
//! * **Pagination** via `nextPageToken` for large calendars.
//! * **P72-B-03 DEFERRED**: Webhook push notifications require a publicly
//!   reachable HTTPS endpoint, which is not available in selfhost V1.
//!   All sync is polling-based.

pub mod sync;
pub use sync::{GoogleCalendarSyncService, GoogleChannelRenewalResult, GoogleChannelRenewalService};

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, instrument, trace, warn};

/// Maximum number of retry attempts for transient HTTP errors (429, 502, 503).
const GOOGLE_MAX_RETRIES: u32 = 3;

// ─── Google Calendar API response types ──────────────────────────────────────

/// Response from `Events.watch` / channel registration.
#[derive(Debug, Clone)]
pub struct GoogleWatchResponse {
  /// The channel identifier we sent (echoed back by Google).
  pub channel_id: String,
  /// Google-assigned resource identifier for this watch.
  pub resource_id: String,
  /// UTC expiry time for this channel.
  pub expiry: DateTime<Utc>,
}

/// A single event from the Google Calendar Events.list response.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEvent {
  /// Opaque event identifier.
  pub id: String,
  /// Opaque entity tag used for conditional update/delete requests.
  #[serde(default)]
  pub etag: Option<String>,
  /// Event status: `"confirmed"`, `"tentative"`, or `"cancelled"`.
  #[serde(default)]
  pub status: Option<String>,
  /// Event summary (title).
  #[serde(default)]
  pub summary: Option<String>,
  /// Event description (body text).
  #[serde(default)]
  pub description: Option<String>,
  /// Physical location or meeting room.
  #[serde(default)]
  pub location: Option<String>,
  /// Event start time.
  #[serde(default)]
  pub start: Option<GoogleEventDateTime>,
  /// Event end time.
  #[serde(default)]
  pub end: Option<GoogleEventDateTime>,
  /// The organiser.
  #[serde(default)]
  pub organizer: Option<GoogleEventAttendee>,
  /// List of attendees.
  #[serde(default)]
  pub attendees: Option<Vec<GoogleEventAttendee>>,
  /// Recurrence rules (RRULE strings).
  #[serde(default)]
  pub recurrence: Option<Vec<String>>,
  /// For instances of recurring events, the ID of the recurring event.
  #[serde(default)]
  pub recurring_event_id: Option<String>,
  /// iCalendar UID (maps to `remote_event_id`).
  #[serde(default, rename = "iCalUID")]
  pub ical_uid: Option<String>,
  /// Last modification time.
  #[serde(default)]
  pub updated: Option<String>,
  /// Google Calendar colour identifier (e.g. `"1"` .. `"11"`).
  #[serde(default)]
  pub color_id: Option<String>,
  /// Visibility: `"default"`, `"public"`, `"private"`, `"confidential"`.
  #[serde(default)]
  pub visibility: Option<String>,
}

/// Google Calendar date-time wrapper.
///
/// Exactly one of `date_time` (timed event) or `date` (all-day event) is set.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventDateTime {
  /// RFC 3339 timestamp for timed events.
  #[serde(default)]
  pub date_time: Option<String>,
  /// Date string (`YYYY-MM-DD`) for all-day events.
  #[serde(default)]
  pub date: Option<String>,
  /// IANA timezone identifier (e.g. `"Europe/Berlin"`).
  #[serde(default)]
  pub time_zone: Option<String>,
}

/// A Google Calendar event attendee or organiser.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventAttendee {
  /// Attendee email address.
  #[serde(default)]
  pub email: Option<String>,
  /// Display name.
  #[serde(default)]
  pub display_name: Option<String>,
  /// Response status: `"needsAction"`, `"declined"`, `"tentative"`, `"accepted"`.
  #[serde(default)]
  pub response_status: Option<String>,
  /// Whether this attendee is the organiser.
  #[serde(default)]
  pub organizer: Option<bool>,
  /// Whether this is the calendar owner's own entry.
  #[serde(default, rename = "self")]
  pub is_self: Option<bool>,
}

/// Response from Google Calendar `Events.list`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventsListResponse {
  /// List of events.
  #[serde(default)]
  pub items: Vec<GoogleEvent>,
  /// Token for the next page, `None` when all pages are exhausted.
  #[serde(default)]
  pub next_page_token: Option<String>,
  /// Sync token for incremental delta sync on subsequent calls.
  #[serde(default)]
  pub next_sync_token: Option<String>,
}

/// Response from Google's OAuth2 token refresh endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct GoogleTokenRefreshResponse {
  /// New short-lived access token.
  pub access_token: String,
  /// Token type (always `"Bearer"`).
  #[serde(default)]
  pub token_type: Option<String>,
  /// Lifetime in seconds.
  #[serde(default)]
  pub expires_in: Option<u64>,
  /// Scope granted.
  #[serde(default)]
  pub scope: Option<String>,
}

/// Error from Google's OAuth2 token endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct GoogleTokenErrorResponse {
  pub error: String,
  #[serde(default)]
  pub error_description: Option<String>,
}

// ─── Error type ──────────────────────────────────────────────────────────────

// ─── Write-back request body types (P90-CAL-G-01) ────────────────────────────

/// Request body for Google Calendar Events.insert / Events.update.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEventBody {
  /// Event title.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub summary: Option<String>,
  /// Description / body text.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// Physical location or meeting URL.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub location: Option<String>,
  /// Start time.
  pub start: GoogleDateTime,
  /// End time.
  pub end: GoogleDateTime,
  /// Attendees.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub attendees: Vec<GoogleAttendee>,
  /// Recurrence rules (RRULE strings).
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub recurrence: Vec<String>,
  /// Reminder overrides.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reminders: Option<GoogleReminders>,
  /// Event status: `"confirmed"`, `"tentative"`, or `"cancelled"`.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub status: Option<String>,
  /// Transparency: `"opaque"` (busy) or `"transparent"` (free).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub transparency: Option<String>,
}

/// Date-time wrapper for Google Calendar API request bodies.
///
/// Exactly one of `date_time` (timed event) or `date` (all-day event) is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDateTime {
  /// RFC 3339 timestamp for timed events.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub date_time: Option<String>,
  /// Date string `YYYY-MM-DD` for all-day events.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub date: Option<String>,
  /// IANA timezone identifier.
  #[serde(rename = "timeZone", skip_serializing_if = "Option::is_none")]
  pub time_zone: Option<String>,
}

/// Attendee record in a write-back request body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAttendee {
  pub email: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub display_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub response_status: Option<String>,
}

/// Reminder configuration for a write-back request body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleReminders {
  pub use_default: bool,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub overrides: Vec<GoogleReminderOverride>,
}

/// A single reminder override (popup or email).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleReminderOverride {
  /// `"email"` or `"popup"`.
  pub method: String,
  /// Minutes before the event.
  pub minutes: i32,
}

/// Enum controlling who receives update notifications on delete.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SendUpdates {
  All,
  ExternalOnly,
  None,
}

impl SendUpdates {
  fn as_str(self) -> &'static str {
    match self {
      SendUpdates::All => "all",
      SendUpdates::ExternalOnly => "externalOnly",
      SendUpdates::None => "none",
    }
  }
}

/// Errors returned by the Google Calendar client.
#[derive(Debug, thiserror::Error)]
pub enum GoogleCalendarError {
  /// Network-level error (connect timeout, DNS failure, etc.).
  #[error("network error: {0}")]
  Network(String),
  /// Authentication failure (401 / token refresh failed).
  #[error("authentication error: {0}")]
  Auth(String),
  /// Unexpected HTTP status code.
  #[error("HTTP {0}: {1}")]
  Http(u16, String),
  /// JSON parsing error.
  #[error("parse error: {0}")]
  Parse(String),
  /// Sync token invalidated — caller should perform a full re-sync.
  #[error("sync token expired (HTTP 410): full re-sync required")]
  SyncTokenExpired,
  /// ETag precondition failed (409 / 412) — the remote event was modified
  /// concurrently.  Caller should re-fetch and retry.
  #[error("ETag conflict: remote event was modified concurrently")]
  EtagConflict,
}

// ─── Client ──────────────────────────────────────────────────────────────────

/// Thin Google Calendar API v3 HTTP client.
///
/// Constructed per sync run with a valid OAuth2 access token. Token refresh
/// is handled externally by the sync service before constructing this client.
pub struct GoogleCalendarClient {
  http: Client,
  access_token: String,
}

/// Result of a single `list_events` call (one page).
#[derive(Debug, Clone)]
pub struct EventsPage {
  /// Events returned in this page.
  pub events: Vec<GoogleEvent>,
  /// Token for fetching the next page, `None` if this was the last page.
  pub next_page_token: Option<String>,
  /// Sync token for incremental sync on subsequent runs.
  /// Only present on the **last page** of a listing.
  pub next_sync_token: Option<String>,
}

impl GoogleCalendarClient {
  /// Construct a new client with a valid access token.
  pub fn new(
    access_token: String,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, GoogleCalendarError> {
    let http = crate::tls::build_http_client(
      Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Myoxus-GoogleCalendar/1.0"),
      additional_ca,
    )
    .map_err(|e| GoogleCalendarError::Network(format!("failed to build HTTP client: {e}")))?;
    Ok(Self { http, access_token })
  }

  /// Construct a client with a custom reqwest `Client` (for testing).
  #[cfg(test)]
  pub fn with_http(http: Client, access_token: String) -> Self {
    Self { http, access_token }
  }

  /// Fetch a single page of events from the Google Calendar API.
  ///
  /// # Parameters
  ///
  /// * `calendar_id` — The calendar identifier (usually `"primary"` or an
  ///   email address).
  /// * `time_min` / `time_max` — Optional time window bounds (RFC 3339).
  ///   Ignored when `sync_token` is provided (Google API constraint).
  /// * `page_token` — Pagination cursor from a previous response.
  /// * `sync_token` — Incremental sync token from a previous full listing.
  ///   When set, `time_min` and `time_max` are ignored by the API.
  #[instrument(skip(self), fields(%calendar_id))]
  pub async fn list_events(
    &self,
    calendar_id: &str,
    time_min: Option<DateTime<Utc>>,
    time_max: Option<DateTime<Utc>>,
    page_token: Option<&str>,
    sync_token: Option<&str>,
  ) -> Result<EventsPage, GoogleCalendarError> {
    let url = format!(
      "https://www.googleapis.com/calendar/v3/calendars/{}/events",
      urlencoding::encode(calendar_id),
    );

    let mut params: Vec<(&str, String)> = vec![("singleEvents", "true".to_string()), ("maxResults", "250".to_string())];

    if let Some(st) = sync_token {
      // Incremental sync — time_min/time_max must NOT be set.
      params.push(("syncToken", st.to_string()));
    } else {
      // Full sync — apply time window.
      if let Some(tmin) = time_min {
        params.push(("timeMin", tmin.to_rfc3339()));
      }
      if let Some(tmax) = time_max {
        params.push(("timeMax", tmax.to_rfc3339()));
      }
    }

    if let Some(pt) = page_token {
      params.push(("pageToken", pt.to_string()));
    }

    trace!(%url, param_count = params.len(), "google_calendar: issuing Events.list");

    // Use retry_on_transient via the inner-result pattern:
    //   Err(e)           → transient — retry_on_transient will retry
    //   Ok(Ok(body))     → success
    //   Ok(Err(e))       → permanent error — passes through immediately
    let body = crate::http_retry::retry_on_transient("google_calendar::list_events", GOOGLE_MAX_RETRIES, || {
      let http = &self.http;
      let url = &url;
      let params = &params;
      let access_token = &self.access_token;
      async move {
        let response = http
          .get(url)
          .bearer_auth(access_token)
          .query(params)
          .send()
          .await
          .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

        let status = response.status();
        let code = status.as_u16();

        // HTTP 410 Gone → syncToken expired (permanent, do not retry).
        if code == 410 {
          warn!(%calendar_id, "google_calendar: sync token expired (410 Gone)");
          return Ok(Err(GoogleCalendarError::SyncTokenExpired));
        }

        if code == 401 {
          return Ok(Err(GoogleCalendarError::Auth(
            "access token rejected (401)".to_string(),
          )));
        }

        // Retryable status — return Err so retry_on_transient retries.
        if crate::http_retry::RETRYABLE_STATUS_CODES.contains(&code) {
          let body = response.text().await.unwrap_or_default();
          return Err(GoogleCalendarError::Http(
            code,
            format!("Events.list {calendar_id}: transient HTTP {code} — {body}"),
          ));
        }

        if !status.is_success() {
          let body = response.text().await.unwrap_or_default();
          return Ok(Err(GoogleCalendarError::Http(
            code,
            format!("Events.list {calendar_id}: {status} — {body}"),
          )));
        }

        let body = response
          .text()
          .await
          .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;
        Ok(Ok(body))
      }
    })
    .await??;

    debug!(%calendar_id, response_bytes = body.len(), "google_calendar: Events.list response received");

    let parsed: GoogleEventsListResponse =
      serde_json::from_str(&body).map_err(|e| GoogleCalendarError::Parse(e.to_string()))?;

    trace!(
      %calendar_id,
      event_count = parsed.items.len(),
      has_next_page = parsed.next_page_token.is_some(),
      has_sync_token = parsed.next_sync_token.is_some(),
      "google_calendar: page parsed"
    );

    Ok(EventsPage {
      events: parsed.items,
      next_page_token: parsed.next_page_token,
      next_sync_token: parsed.next_sync_token,
    })
  }

  /// Fetch **all** events across all pages, handling pagination automatically.
  ///
  /// Returns the complete event list and the final `syncToken` for use in
  /// subsequent incremental syncs.
  #[instrument(skip(self), fields(%calendar_id))]
  pub async fn list_all_events(
    &self,
    calendar_id: &str,
    time_min: Option<DateTime<Utc>>,
    time_max: Option<DateTime<Utc>>,
    sync_token: Option<&str>,
  ) -> Result<(Vec<GoogleEvent>, Option<String>), GoogleCalendarError> {
    let mut all_events: Vec<GoogleEvent> = Vec::new();
    let mut page_token: Option<String> = None;
    let mut final_sync_token: Option<String> = None;
    let mut page_num = 0u32;

    loop {
      page_num += 1;
      let page = self
        .list_events(calendar_id, time_min, time_max, page_token.as_deref(), sync_token)
        .await?;

      trace!(
        %calendar_id,
        page_num,
        events_in_page = page.events.len(),
        "google_calendar: page fetched"
      );

      all_events.extend(page.events);

      if let Some(nst) = page.next_sync_token {
        final_sync_token = Some(nst);
      }

      match page.next_page_token {
        Some(npt) => {
          page_token = Some(npt);
        }
        None => break,
      }

      // Safety valve: prevent infinite pagination loops.
      if page_num > 200 {
        warn!(%calendar_id, "google_calendar: pagination exceeded 200 pages, aborting");
        break;
      }
    }

    debug!(
      %calendar_id,
      total_events = all_events.len(),
      pages = page_num,
      has_sync_token = final_sync_token.is_some(),
      "google_calendar: all pages fetched"
    );

    Ok((all_events, final_sync_token))
  }

  // ─── Webhook channel management (P90-CAL-B-01 / B-03) ───────────────────

  /// Register a Google Calendar push-notification channel via `Events.watch`.
  ///
  /// # Parameters
  ///
  /// * `calendar_id` — Calendar to watch (usually `"primary"`).
  /// * `channel_id` — Our identifier for this channel (a UUID string).
  /// * `callback_url` — Publicly reachable HTTPS URL Google will POST to.
  ///
  /// Returns a [`GoogleWatchResponse`] with the resource_id and expiry.
  #[instrument(skip(self), fields(%calendar_id, %channel_id))]
  pub async fn register_watch(
    &self,
    calendar_id: &str,
    channel_id: &str,
    callback_url: &str,
    webhook_secret: Option<&str>,
  ) -> Result<GoogleWatchResponse, GoogleCalendarError> {
    let url = format!(
      "https://www.googleapis.com/calendar/v3/calendars/{}/events/watch",
      urlencoding::encode(calendar_id),
    );
    let token_value = webhook_secret.unwrap_or("");
    let body = serde_json::json!({
      "id": channel_id,
      "type": "web_hook",
      "address": callback_url,
      "token": token_value,
    });

    debug!(%calendar_id, %channel_id, "google_calendar: registering Events.watch channel");

    let response = self
      .http
      .post(&url)
      .bearer_auth(&self.access_token)
      .json(&body)
      .send()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    let status = response.status();
    let code = status.as_u16();

    if code == 401 {
      return Err(GoogleCalendarError::Auth(
        "access token rejected for Events.watch (401)".to_string(),
      ));
    }
    if !status.is_success() {
      let body_text = response.text().await.unwrap_or_default();
      return Err(GoogleCalendarError::Http(
        code,
        format!("Events.watch {calendar_id}: {status} — {body_text}"),
      ));
    }

    let resp_text = response
      .text()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WatchResponseRaw {
      id: String,
      resource_id: String,
      expiration: String,
    }

    let raw: WatchResponseRaw =
      serde_json::from_str(&resp_text).map_err(|e| GoogleCalendarError::Parse(e.to_string()))?;

    // `expiration` is Unix timestamp in milliseconds as a string.
    let expiry_ms: i64 = raw
      .expiration
      .parse()
      .map_err(|_| GoogleCalendarError::Parse(format!("invalid expiration value: {}", raw.expiration)))?;
    let expiry = chrono::DateTime::from_timestamp_millis(expiry_ms)
      .map(|dt| dt.with_timezone(&chrono::Utc))
      .ok_or_else(|| GoogleCalendarError::Parse("expiration out of range".to_string()))?;

    debug!(
      %calendar_id,
      channel_id = %raw.id,
      resource_id = %raw.resource_id,
      ?expiry,
      "google_calendar: Events.watch channel registered"
    );

    Ok(GoogleWatchResponse {
      channel_id: raw.id,
      resource_id: raw.resource_id,
      expiry,
    })
  }

  // ─── Write-back methods (P90-CAL-G-02, G-03, G-04) ─────────────────────────

  /// Create a new event via Google Calendar Events.insert.
  ///
  /// Issues `POST .../calendars/{calendarId}/events` with the event body.
  /// Returns the created [`GoogleEvent`] (contains the server-assigned `id`
  /// and `etag`).
  ///
  /// On 401 the access token was rejected — caller should refresh and retry.
  #[instrument(skip(self, event_body), fields(%calendar_id))]
  pub async fn create_event(
    &self,
    calendar_id: &str,
    event_body: &GoogleEventBody,
  ) -> Result<GoogleEvent, GoogleCalendarError> {
    let url = format!(
      "https://www.googleapis.com/calendar/v3/calendars/{}/events",
      urlencoding::encode(calendar_id),
    );

    debug!(%calendar_id, "google_calendar: Events.insert");

    let response = self
      .http
      .post(&url)
      .bearer_auth(&self.access_token)
      .json(event_body)
      .send()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    let status = response.status();
    let code = status.as_u16();

    if code == 401 {
      return Err(GoogleCalendarError::Auth(
        "access token rejected for Events.insert (401)".to_string(),
      ));
    }
    if !status.is_success() {
      let body_text = response.text().await.unwrap_or_default();
      return Err(GoogleCalendarError::Http(
        code,
        format!("Events.insert {calendar_id}: {status} — {body_text}"),
      ));
    }

    let body_text = response
      .text()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;
    let event: GoogleEvent = serde_json::from_str(&body_text).map_err(|e| GoogleCalendarError::Parse(e.to_string()))?;

    debug!(
      %calendar_id,
      event_id = %event.id,
      "google_calendar: Events.insert succeeded"
    );
    Ok(event)
  }

  /// Update an existing event via Google Calendar Events.update.
  ///
  /// Issues `PUT .../calendars/{calendarId}/events/{eventId}` with
  /// `If-Match: "{etag}"` for optimistic locking.
  ///
  /// Returns `Err(GoogleCalendarError::EtagConflict)` on 409 or 412.
  /// On 401 the token was rejected — caller should refresh and retry.
  #[instrument(skip(self, event_body), fields(%calendar_id, %event_id))]
  pub async fn update_event(
    &self,
    calendar_id: &str,
    event_id: &str,
    event_body: &GoogleEventBody,
    etag: &str,
  ) -> Result<GoogleEvent, GoogleCalendarError> {
    let url = format!(
      "https://www.googleapis.com/calendar/v3/calendars/{}/events/{}",
      urlencoding::encode(calendar_id),
      urlencoding::encode(event_id),
    );

    // Add quotes around the ETag if not already present.
    let quoted_etag = if etag.starts_with('"') {
      etag.to_string()
    } else {
      format!("\"{etag}\"")
    };

    debug!(%calendar_id, %event_id, "google_calendar: Events.update");

    let response = self
      .http
      .put(&url)
      .bearer_auth(&self.access_token)
      .header("If-Match", &quoted_etag)
      .json(event_body)
      .send()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    let status = response.status();
    let code = status.as_u16();

    if code == 409 || code == 412 {
      return Err(GoogleCalendarError::EtagConflict);
    }
    if code == 401 {
      return Err(GoogleCalendarError::Auth(
        "access token rejected for Events.update (401)".to_string(),
      ));
    }
    if !status.is_success() {
      let body_text = response.text().await.unwrap_or_default();
      return Err(GoogleCalendarError::Http(
        code,
        format!("Events.update {calendar_id}/{event_id}: {status} — {body_text}"),
      ));
    }

    let body_text = response
      .text()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;
    let event: GoogleEvent = serde_json::from_str(&body_text).map_err(|e| GoogleCalendarError::Parse(e.to_string()))?;

    debug!(
      %calendar_id,
      %event_id,
      "google_calendar: Events.update succeeded"
    );
    Ok(event)
  }

  /// Delete an event via Google Calendar Events.delete.
  ///
  /// Issues `DELETE .../calendars/{calendarId}/events/{eventId}` with the
  /// persisted ETag as `If-Match`; 409/412 therefore preserve newer remote
  /// content instead of forcing its deletion.
  ///
  /// **Idempotent**: a `404 Not Found` or `410 Gone` response is treated as
  /// success because the desired postcondition (event absent) is already met.
  ///
  /// `send_updates` controls whether attendees receive cancellation emails.
  #[instrument(skip(self), fields(%calendar_id, %event_id))]
  pub async fn delete_event(
    &self,
    calendar_id: &str,
    event_id: &str,
    etag: &str,
    send_updates: SendUpdates,
  ) -> Result<(), GoogleCalendarError> {
    let url = format!(
      "https://www.googleapis.com/calendar/v3/calendars/{}/events/{}",
      urlencoding::encode(calendar_id),
      urlencoding::encode(event_id),
    );

    debug!(%calendar_id, %event_id, "google_calendar: Events.delete");
    let quoted_etag = if etag.starts_with('"') {
      etag.to_string()
    } else {
      format!("\"{etag}\"")
    };

    let response = self
      .http
      .delete(&url)
      .bearer_auth(&self.access_token)
      .header("If-Match", quoted_etag)
      .query(&[("sendUpdates", send_updates.as_str())])
      .send()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    let status = response.status();
    let code = status.as_u16();

    match code {
      // 204 No Content — successful deletion.
      204 => {
        debug!(%calendar_id, %event_id, "google_calendar: Events.delete succeeded (204)");
        Ok(())
      }
      // 404 or 410 — event already gone (idempotent).
      404 | 410 => {
        debug!(%calendar_id, %event_id, "google_calendar: Events.delete: event already absent ({code})");
        Ok(())
      }
      409 | 412 => Err(GoogleCalendarError::EtagConflict),
      401 => Err(GoogleCalendarError::Auth(
        "access token rejected for Events.delete (401)".to_string(),
      )),
      _ => {
        let body_text = response.text().await.unwrap_or_default();
        Err(GoogleCalendarError::Http(
          code,
          format!("Events.delete {calendar_id}/{event_id}: {status} — {body_text}"),
        ))
      }
    }
  }

  /// Stop an active Google Calendar push-notification channel.
  ///
  /// Issues `POST https://www.googleapis.com/calendar/v3/channels/stop`.
  /// Non-fatal: if the channel is already expired/invalid Google returns 404
  /// which we treat as success (idempotent stop).
  #[instrument(skip(self), fields(%channel_id, %resource_id))]
  pub async fn stop_channel(&self, channel_id: &str, resource_id: &str) -> Result<(), GoogleCalendarError> {
    let body = serde_json::json!({
      "id": channel_id,
      "resourceId": resource_id,
    });

    debug!(%channel_id, %resource_id, "google_calendar: stopping push channel");

    let response = self
      .http
      .post("https://www.googleapis.com/calendar/v3/channels/stop")
      .bearer_auth(&self.access_token)
      .json(&body)
      .send()
      .await
      .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

    let status = response.status();
    // 204 No Content = success; 404 = channel already gone (idempotent).
    if status.as_u16() == 204 || status.as_u16() == 404 {
      debug!(%channel_id, status = status.as_u16(), "google_calendar: channel stop accepted");
      return Ok(());
    }
    if !status.is_success() {
      let body_text = response.text().await.unwrap_or_default();
      return Err(GoogleCalendarError::Http(
        status.as_u16(),
        format!("channels/stop: {status} — {body_text}"),
      ));
    }
    Ok(())
  }
}

// ─── Token refresh ───────────────────────────────────────────────────────────

/// Refresh a Google OAuth2 access token using a long-lived refresh token.
///
/// This is a standalone function (not on `GoogleCalendarClient`) because
/// the client requires a valid access token at construction time — the
/// refresh happens _before_ constructing the client.
///
/// Retries up to 3 times on transient errors (network failures, 429, 5xx).
/// After all retries are exhausted, the last error is returned.
#[instrument(skip(client_secret, refresh_token, additional_ca))]
pub async fn refresh_google_access_token(
  client_id: &str,
  client_secret: &str,
  refresh_token: &str,
  additional_ca: Option<&crate::tls::ValidatedCaBundle>,
) -> Result<GoogleTokenRefreshResponse, GoogleCalendarError> {
  let http = crate::tls::build_http_client(Client::builder().timeout(Duration::from_secs(15)), additional_ca)
    .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

  let params = [
    ("client_id", client_id),
    ("client_secret", client_secret),
    ("refresh_token", refresh_token),
    ("grant_type", "refresh_token"),
  ];

  debug!(%client_id, "google_calendar: refreshing access token");

  // Use retry_on_transient via the inner-result pattern:
  //   Err(e)           → transient — retry_on_transient will retry
  //   Ok(Ok(resp))     → success
  //   Ok(Err(e))       → permanent error — passes through immediately
  let token_resp = crate::http_retry::retry_on_transient("google_calendar::token_refresh", GOOGLE_MAX_RETRIES, || {
    let http = &http;
    let params = &params;
    async move {
      let response = http
        .post("https://oauth2.googleapis.com/token")
        .form(params)
        .send()
        .await
        .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

      let status = response.status();
      let code = status.as_u16();
      let body = response
        .text()
        .await
        .map_err(|e| GoogleCalendarError::Network(e.to_string()))?;

      // Retry on transient server errors and rate limits.
      if crate::http_retry::RETRYABLE_STATUS_CODES.contains(&code) {
        return Err(GoogleCalendarError::Http(
          code,
          format!("token refresh transient HTTP {code}"),
        ));
      }

      if !status.is_success() {
        // Permanent error — do not retry.
        if let Ok(err_resp) = serde_json::from_str::<GoogleTokenErrorResponse>(&body) {
          error!(
            %client_id,
            error = %err_resp.error,
            description = err_resp.error_description.as_deref().unwrap_or(""),
            "google_calendar: token refresh failed"
          );
          return Ok(Err(GoogleCalendarError::Auth(format!(
            "token refresh failed: {} — {}",
            err_resp.error,
            err_resp.error_description.unwrap_or_default()
          ))));
        }
        return Ok(Err(GoogleCalendarError::Http(code, body)));
      }

      // Success — parse the token response.
      let token_resp: GoogleTokenRefreshResponse =
        serde_json::from_str(&body).map_err(|e| GoogleCalendarError::Parse(e.to_string()))?;

      debug!(
        %client_id,
        expires_in = token_resp.expires_in,
        "google_calendar: access token refreshed successfully"
      );

      Ok(Ok(token_resp))
    }
  })
  .await??;

  Ok(token_resp)
}

// ─── Helper: parse Google date/time → chrono::DateTime<Utc> ──────────────────

/// Parse a [`GoogleEventDateTime`] into a UTC [`DateTime`].
///
/// Falls back to midnight UTC for all-day events.
pub fn parse_google_datetime(gdt: &GoogleEventDateTime) -> Option<DateTime<Utc>> {
  if let Some(ref dt_str) = gdt.date_time {
    // Try RFC 3339 first (Google usually returns this).
    if let Ok(dt) = DateTime::parse_from_rfc3339(dt_str) {
      return Some(dt.with_timezone(&Utc));
    }
    // Fallback: try without timezone offset.
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(dt_str, "%Y-%m-%dT%H:%M:%S") {
      return Some(naive.and_utc());
    }
    warn!(date_time = %dt_str, "google_calendar: failed to parse dateTime");
    return None;
  }

  if let Some(ref d_str) = gdt.date {
    if let Ok(date) = chrono::NaiveDate::parse_from_str(d_str, "%Y-%m-%d") {
      return Some(date.and_hms_opt(0, 0, 0).expect("midnight is always valid").and_utc());
    }
    warn!(date = %d_str, "google_calendar: failed to parse date");
    return None;
  }

  None
}

/// Returns `true` if this [`GoogleEventDateTime`] represents an all-day event
/// (i.e. the `date` field is set rather than `dateTime`).
pub fn is_all_day(gdt: &GoogleEventDateTime) -> bool {
  gdt.date.is_some() && gdt.date_time.is_none()
}

// ─── G-05: CalendarEvent → GoogleEventBody conversion ────────────────────────

/// Convert a local [`myoxus_domain::entities::CalendarEvent`] into a
/// [`GoogleEventBody`] suitable for use with `create_event` / `update_event`.
///
/// All-day detection: if the event starts and ends at midnight UTC (00:00:00)
/// the `date` field is used instead of `dateTime`.
pub fn to_google_event_body(event: &myoxus_domain::entities::CalendarEvent) -> GoogleEventBody {
  // Extract provider metadata from payload if available.
  let description = event.description.clone().or_else(|| {
    event
      .payload
      .get("description")
      .and_then(|v| v.as_str())
      .map(str::to_string)
  });
  let location = event.location.clone().or_else(|| {
    event
      .payload
      .get("location")
      .and_then(|v| v.as_str())
      .map(str::to_string)
  });
  let status = event.payload.get("status").and_then(|v| v.as_str()).map(str::to_string);
  let rrule = event
    .payload
    .get("rrule")
    .and_then(|v| v.as_str())
    .map(|r| format!("RRULE:{r}"));

  // Build start/end date-time objects.
  let starts_midnight = event.starts_at.time() == chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap();
  let ends_midnight = event.ends_at.time() == chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap();
  let all_day = starts_midnight && ends_midnight;

  let (start, end) = if all_day {
    (
      GoogleDateTime {
        date: Some(event.starts_at.format("%Y-%m-%d").to_string()),
        date_time: None,
        time_zone: None,
      },
      GoogleDateTime {
        date: Some(event.ends_at.format("%Y-%m-%d").to_string()),
        date_time: None,
        time_zone: None,
      },
    )
  } else {
    (
      GoogleDateTime {
        date_time: Some(event.starts_at.to_rfc3339()),
        date: None,
        time_zone: Some("UTC".to_string()),
      },
      GoogleDateTime {
        date_time: Some(event.ends_at.to_rfc3339()),
        date: None,
        time_zone: Some("UTC".to_string()),
      },
    )
  };

  // Map participants to attendees.
  let attendees = event
    .participants
    .iter()
    .map(|p| GoogleAttendee {
      email: p.email.clone(),
      display_name: p.display_name.clone(),
      response_status: Some(p.response_status.clone()),
    })
    .collect();

  GoogleEventBody {
    summary: event.title.clone(),
    description,
    location,
    start,
    end,
    attendees,
    recurrence: rrule.map(|r| vec![r]).unwrap_or_default(),
    reminders: None,
    status,
    transparency: None,
  }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::{Datelike, Timelike};

  #[test]
  fn parse_rfc3339_datetime() {
    let gdt = GoogleEventDateTime {
      date_time: Some("2026-03-27T10:00:00+02:00".to_string()),
      date: None,
      time_zone: Some("Europe/Berlin".to_string()),
    };
    let dt = parse_google_datetime(&gdt).unwrap();
    assert_eq!(dt.hour(), 8, "10:00+02:00 should be 08:00 UTC");
    assert_eq!(dt.year(), 2026);
  }

  #[test]
  fn parse_all_day_date() {
    let gdt = GoogleEventDateTime {
      date_time: None,
      date: Some("2026-06-15".to_string()),
      time_zone: None,
    };
    let dt = parse_google_datetime(&gdt).unwrap();
    assert_eq!(dt.year(), 2026);
    assert_eq!(dt.month(), 6);
    assert_eq!(dt.day(), 15);
    assert_eq!(dt.hour(), 0);
  }

  #[test]
  fn parse_naive_datetime_without_tz() {
    let gdt = GoogleEventDateTime {
      date_time: Some("2026-01-15T14:30:00".to_string()),
      date: None,
      time_zone: None,
    };
    let dt = parse_google_datetime(&gdt).unwrap();
    assert_eq!(dt.hour(), 14);
    assert_eq!(dt.minute(), 30);
  }

  #[test]
  fn parse_empty_returns_none() {
    let gdt = GoogleEventDateTime {
      date_time: None,
      date: None,
      time_zone: None,
    };
    assert!(parse_google_datetime(&gdt).is_none());
  }

  #[test]
  fn is_all_day_flag() {
    let all_day = GoogleEventDateTime {
      date_time: None,
      date: Some("2026-03-01".to_string()),
      time_zone: None,
    };
    assert!(is_all_day(&all_day));

    let timed = GoogleEventDateTime {
      date_time: Some("2026-03-01T10:00:00Z".to_string()),
      date: None,
      time_zone: None,
    };
    assert!(!is_all_day(&timed));
  }

  #[test]
  fn deserialize_events_list_response() {
    let json = r#"{
      "items": [
        {
          "id": "ev1",
          "status": "confirmed",
          "summary": "Team standup",
          "start": {"dateTime": "2026-03-27T09:00:00Z"},
          "end": {"dateTime": "2026-03-27T09:30:00Z"},
          "iCalUID": "ev1@google.com"
        }
      ],
      "nextPageToken": "page2token",
      "nextSyncToken": null
    }"#;

    let resp: GoogleEventsListResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.items.len(), 1);
    assert_eq!(resp.items[0].id, "ev1");
    assert_eq!(resp.items[0].summary.as_deref(), Some("Team standup"));
    assert_eq!(resp.next_page_token.as_deref(), Some("page2token"));
    assert!(resp.next_sync_token.is_none());
  }

  #[test]
  fn deserialize_events_list_with_sync_token() {
    let json = r#"{
      "items": [],
      "nextSyncToken": "CLDvhY..."
    }"#;
    let resp: GoogleEventsListResponse = serde_json::from_str(json).unwrap();
    assert!(resp.items.is_empty());
    assert_eq!(resp.next_sync_token.as_deref(), Some("CLDvhY..."));
    assert!(resp.next_page_token.is_none());
  }

  #[test]
  fn deserialize_attendees() {
    let json = r#"{
      "id": "ev2",
      "attendees": [
        {
          "email": "alice@example.com",
          "displayName": "Alice",
          "responseStatus": "accepted",
          "organizer": true
        },
        {
          "email": "bob@example.com",
          "responseStatus": "tentative"
        }
      ]
    }"#;
    let event: GoogleEvent = serde_json::from_str(json).unwrap();
    let attendees = event.attendees.unwrap();
    assert_eq!(attendees.len(), 2);
    assert_eq!(attendees[0].email.as_deref(), Some("alice@example.com"));
    assert_eq!(attendees[0].organizer, Some(true));
    assert_eq!(attendees[1].response_status.as_deref(), Some("tentative"));
  }

  #[test]
  fn deserialize_token_refresh_response() {
    let json = r#"{
      "access_token": "ya29.newtoken",
      "token_type": "Bearer",
      "expires_in": 3600,
      "scope": "https://www.googleapis.com/auth/calendar.readonly"
    }"#;
    let resp: GoogleTokenRefreshResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.access_token, "ya29.newtoken");
    assert_eq!(resp.expires_in, Some(3600));
  }

  #[test]
  fn deserialize_token_error_response() {
    let json = r#"{
      "error": "invalid_grant",
      "error_description": "Token has been expired or revoked."
    }"#;
    let resp: GoogleTokenErrorResponse = serde_json::from_str(json).unwrap();
    assert_eq!(resp.error, "invalid_grant");
    assert!(resp.error_description.unwrap().contains("expired"));
  }

  #[test]
  fn deserialize_color_and_visibility_fields() {
    let json = r#"{
      "id": "ev_color",
      "status": "confirmed",
      "summary": "Coloured event",
      "colorId": "3",
      "visibility": "private",
      "start": {"dateTime": "2026-04-01T09:00:00Z"},
      "end": {"dateTime": "2026-04-01T10:00:00Z"}
    }"#;
    let event: GoogleEvent = serde_json::from_str(json).unwrap();
    assert_eq!(event.color_id.as_deref(), Some("3"));
    assert_eq!(event.visibility.as_deref(), Some("private"));
  }

  #[test]
  fn color_and_visibility_default_to_none() {
    let json = r#"{"id": "ev_plain"}"#;
    let event: GoogleEvent = serde_json::from_str(json).unwrap();
    assert!(event.color_id.is_none());
    assert!(event.visibility.is_none());
  }

  #[test]
  fn parse_cancelled_event() {
    let json = r#"{
      "id": "cancelled1",
      "status": "cancelled",
      "start": {"dateTime": "2026-03-27T10:00:00Z"},
      "end": {"dateTime": "2026-03-27T11:00:00Z"}
    }"#;
    let event: GoogleEvent = serde_json::from_str(json).unwrap();
    assert_eq!(event.status.as_deref(), Some("cancelled"));
    assert!(event.summary.is_none());
  }

  #[test]
  fn parse_recurring_event() {
    let json = r#"{
      "id": "recurring1",
      "summary": "Weekly sync",
      "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      "start": {"dateTime": "2026-03-30T09:00:00Z"},
      "end": {"dateTime": "2026-03-30T10:00:00Z"}
    }"#;
    let event: GoogleEvent = serde_json::from_str(json).unwrap();
    let rules = event.recurrence.unwrap();
    assert_eq!(rules.len(), 1);
    assert!(rules[0].contains("FREQ=WEEKLY"));
  }

  // ─── G-T01: Write-back struct tests ────────────────────────────────────────

  /// Verify that `GoogleEventBody` serialises to the format expected by the
  /// Google Calendar API (camelCase field names, RFC 3339 dateTime).
  #[test]
  fn google_event_body_serializes_correctly() {
    let body = GoogleEventBody {
      summary: Some("Team Meeting".to_string()),
      description: Some("Agenda: weekly sync".to_string()),
      location: Some("Berlin HQ".to_string()),
      start: GoogleDateTime {
        date_time: Some("2026-04-01T10:00:00Z".to_string()),
        date: None,
        time_zone: Some("UTC".to_string()),
      },
      end: GoogleDateTime {
        date_time: Some("2026-04-01T11:00:00Z".to_string()),
        date: None,
        time_zone: Some("UTC".to_string()),
      },
      attendees: vec![GoogleAttendee {
        email: "alice@example.com".to_string(),
        display_name: Some("Alice".to_string()),
        response_status: Some("accepted".to_string()),
      }],
      recurrence: vec![],
      reminders: None,
      status: Some("confirmed".to_string()),
      transparency: None,
    };

    let json = serde_json::to_value(&body).unwrap();

    // Verify camelCase field names.
    assert_eq!(json["summary"], "Team Meeting");
    assert_eq!(json["description"], "Agenda: weekly sync");
    assert_eq!(json["location"], "Berlin HQ");
    assert_eq!(json["start"]["dateTime"], "2026-04-01T10:00:00Z");
    assert_eq!(json["start"]["timeZone"], "UTC");
    assert_eq!(json["end"]["dateTime"], "2026-04-01T11:00:00Z");
    assert_eq!(json["attendees"][0]["email"], "alice@example.com");
    assert_eq!(json["attendees"][0]["displayName"], "Alice");
    assert_eq!(json["status"], "confirmed");
    // Fields with None should be absent (skip_serializing_if = "Option::is_none").
    assert!(json.get("transparency").is_none() || json["transparency"].is_null());
  }

  /// Verify that an all-day event serialises with `date: "YYYY-MM-DD"` and no `dateTime`.
  #[test]
  fn google_datetime_all_day() {
    let dt = GoogleDateTime {
      date: Some("2026-06-15".to_string()),
      date_time: None,
      time_zone: None,
    };

    let json = serde_json::to_value(&dt).unwrap();
    assert_eq!(json["date"], "2026-06-15");
    // `dateTime` and `timeZone` should not appear (skip_serializing_if).
    assert!(json.get("dateTime").map(|v| v.is_null()).unwrap_or(true));
    assert!(json.get("timeZone").map(|v| v.is_null()).unwrap_or(true));
  }
}
