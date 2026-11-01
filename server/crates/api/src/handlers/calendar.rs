//! Calendar event, reminder, and Google-webhook endpoint handlers.
//!
//! Implements the REST calendar surface:
//! - `GET /api/workspaces/{id}/calendar/events` — list calendar events in a date range
//! - `POST /api/workspaces/{id}/calendar/events` — create a new event (P90-CAL-E-09)
//! - `PUT /api/workspaces/{id}/calendar/events/{event_id}` — update an event (P90-CAL-E-09)
//! - `DELETE /api/workspaces/{id}/calendar/events/{event_id}` — delete an event (P90-CAL-E-09)
//! - `PUT /api/workspaces/{id}/calendar/reminders/{reminder_id}/status` — acknowledge a reminder
//! - `POST /api/calendar/webhook/google` — receive Google Calendar push notifications

use axum::{
  extract::{Path, Query, State},
  http::{HeaderMap, StatusCode},
  response::{Html, IntoResponse, Json},
};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use myoxus_application::calendar::{CalendarEventUpsert, RsvpStatus};
use myoxus_application::doc::DocSpaceKind;
use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::ports::RemoteEventInput;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::CalendarEvent;
use myoxus_domain::permission::WorkspaceAction;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

// ─── iMIP token helpers (P90-CAL-H-08) ───────────────────────────────────────

type HmacSha256 = Hmac<Sha256>;

/// Sign an iMIP RSVP token (HMAC-SHA256).
///
/// Payload: `{event_id}|{user_id}|{status}|{expires_ts}`
/// Token: base64url(`{payload}.{hex_hmac}`)
pub fn imip_sign_token(event_id: Uuid, user_id: Uuid, status: &str, expires_ts: i64, secret: &str) -> String {
  let payload = format!("{event_id}|{user_id}|{status}|{expires_ts}");
  let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
  mac.update(payload.as_bytes());
  let sig = hex::encode(mac.finalize().into_bytes());
  let raw = format!("{payload}.{sig}");
  base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

/// Verify an iMIP RSVP token.
///
/// Returns `(event_id, user_id, status)` on success.
/// Returns `None` on tampered, expired, or malformed token.
pub fn imip_verify_token(token: &str, secret: &str) -> Option<(Uuid, Uuid, String)> {
  use base64::Engine as _;

  let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
    .decode(token.as_bytes())
    .ok()?;
  let raw = String::from_utf8(decoded).ok()?;

  // Split at the LAST dot to separate payload from HMAC signature.
  let dot_pos = raw.rfind('.')?;
  let payload = &raw[..dot_pos];
  let provided_sig = &raw[dot_pos + 1..];

  // Recompute expected signature and perform a constant-time comparison to
  // prevent timing-oracle attacks.  `subtle::ConstantTimeEq` never
  // short-circuits regardless of input content.
  let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
  mac.update(payload.as_bytes());
  let expected_sig = hex::encode(mac.finalize().into_bytes());

  use subtle::ConstantTimeEq as _;
  let sig_match: bool = expected_sig.as_bytes().ct_eq(provided_sig.as_bytes()).into();
  if !sig_match {
    return None;
  }

  // Parse payload parts.
  let parts: Vec<&str> = payload.splitn(4, '|').collect();
  if parts.len() != 4 {
    return None;
  }

  let event_id = Uuid::parse_str(parts[0]).ok()?;
  let user_id = Uuid::parse_str(parts[1]).ok()?;
  let status = parts[2].to_string();
  let expires_ts: i64 = parts[3].parse().ok()?;

  // Reject expired tokens.
  if expires_ts < chrono::Utc::now().timestamp() {
    return None;
  }

  Some((event_id, user_id, status))
}

fn parse_rsvp_status_str(s: &str) -> Option<RsvpStatus> {
  match s.to_ascii_lowercase().as_str() {
    "accepted" | "accept" => Some(RsvpStatus::Accepted),
    "declined" | "decline" => Some(RsvpStatus::Declined),
    "tentative" => Some(RsvpStatus::Tentative),
    "needs_action" | "needsaction" | "needs-action" => Some(RsvpStatus::NeedsAction),
    _ => None,
  }
}

/// `GET /api/calendar/rsvp/{token}` — iMIP email RSVP handler (P90-CAL-H-08).
///
/// Verifies the HMAC-signed token, updates the participant RSVP status,
/// and returns a simple HTML confirmation page.
///
/// Repeating an unexpired link repeats the participant status update.
#[instrument(skip_all)]
pub(crate) async fn calendar_rsvp_handler(
  State(state): State<ApiState>,
  Path(token): Path<String>,
) -> impl IntoResponse {
  use myoxus_public_render::response_pages::{RsvpPageContext, RsvpPageState, render_rsvp_page};
  let renderer = match state.html_renderer() {
    Ok(renderer) => renderer,
    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
  };
  let response = |http_status: StatusCode, context: RsvpPageContext<'_>| match render_rsvp_page(renderer, &context) {
    Ok(html) => (http_status, Html(html)).into_response(),
    Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
  };
  let secret = &state.config.crypto.private_key;
  let Some((event_id, user_id, status_str)) = imip_verify_token(&token, secret) else {
    return response(
      StatusCode::BAD_REQUEST,
      RsvpPageContext {
        state: RsvpPageState::InvalidLink,
        status: None,
        event_title: None,
        failure: None,
      },
    );
  };
  let Some(rsvp_status) = parse_rsvp_status_str(&status_str) else {
    let display_status = status_str.chars().take(128).collect::<String>();
    return response(
      StatusCode::BAD_REQUEST,
      RsvpPageContext {
        state: RsvpPageState::InvalidStatus,
        status: Some(&display_status),
        event_title: None,
        failure: None,
      },
    );
  };
  let Some(calendar) = state.calendar() else {
    return response(
      StatusCode::INTERNAL_SERVER_ERROR,
      RsvpPageContext {
        state: RsvpPageState::Unavailable,
        status: None,
        event_title: None,
        failure: None,
      },
    );
  };
  match calendar.update_rsvp(event_id, user_id, rsvp_status).await {
    Ok(event) => {
      let status = match rsvp_status {
        RsvpStatus::Accepted => "accepted",
        RsvpStatus::Declined => "declined",
        RsvpStatus::Tentative => "tentative",
        RsvpStatus::NeedsAction => "needs_action",
      };
      info!(event_id = %event_id, user_id = %user_id, status, "iMIP RSVP token processed");
      response(
        StatusCode::OK,
        RsvpPageContext {
          state: RsvpPageState::Success,
          status: Some(status),
          event_title: event.title.as_deref(),
          failure: None,
        },
      )
    }
    Err(e) => {
      warn!(event_id = %event_id, user_id = %user_id, "iMIP RSVP update failed");
      // Domain absence is safe display text. Storage errors can carry connection
      // details and must never reach the template or public response.
      let failure = match &e {
        myoxus_application::auth::AuthError::NotFound(_) => Some(e.to_string().chars().take(512).collect::<String>()),
        _ => None,
      };
      response(
        StatusCode::BAD_REQUEST,
        RsvpPageContext {
          state: RsvpPageState::UpdateFailure,
          status: None,
          event_title: None,
          failure: failure.as_deref(),
        },
      )
    }
  }
}

/// Date-range query parameters for `GET …/calendars/events`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarEventsQueryParams {
  /// Start of the date range (inclusive).
  from: chrono::DateTime<chrono::Utc>,
  /// End of the date range (inclusive).
  to: chrono::DateTime<chrono::Utc>,
}

/// Request body for `POST …/reminder` — acknowledge or un-acknowledge a reminder.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarReminderStatusRequest {
  /// `true` to mark the reminder as delivered, `false` to reset it.
  delivered: bool,
}

/// Success response for reminder status update.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarReminderStatusResponse {
  /// Always `true` on success.
  ok: bool,
}

/// `GET /api/workspaces/{id}/calendars/events` — list calendar events in a date range.
///
/// Requires the caller to have `SettingsRead` on the workspace.  Delegates to
/// [`CalendarService::list_workspace_events`].
#[instrument(skip_all)]
pub(crate) async fn list_calendar_events_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  Query(params): Query<CalendarEventsQueryParams>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsRead,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;
  let calendar = state.calendar().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
  let events = calendar
    .list_workspace_events(workspace_uuid, params.from, params.to)
    .await
    .map_err(|e| {
      error!(workspace_id = %workspace_uuid, user_id = %snapshot.user.id, error = %e, "calendar list handler failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  let events = map_calendar_events_rest(&state, workspace_uuid, events).await?;
  Ok((StatusCode::OK, Json(events)))
}

/// `POST /api/workspaces/{id}/calendars/events/{reminder_id}/reminder` — acknowledge a reminder.
///
/// Requires the caller to have `SettingsUpdate` on the workspace.  Marks the
/// reminder as delivered (or un-delivered) at the current UTC timestamp via
/// [`CalendarService::mark_reminder_status`].
#[instrument(skip_all)]
pub(crate) async fn update_calendar_reminder_status_handler(
  State(state): State<ApiState>,
  Path((workspace_id, reminder_id)): Path<(String, String)>,
  headers: HeaderMap,
  Json(body): Json<CalendarReminderStatusRequest>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let reminder_uuid = Uuid::parse_str(&reminder_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;
  let calendar = state.calendar().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
  calendar
        .mark_reminder_status(reminder_uuid, body.delivered, Some(chrono::Utc::now()))
        .await
        .map_err(|e| {
            error!(workspace_id = %workspace_uuid, reminder_id = %reminder_uuid, user_id = %snapshot.user.id, error = %e, "calendar reminder status update failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
  Ok((StatusCode::OK, Json(CalendarReminderStatusResponse { ok: true })))
}

/// `POST /api/calendar/webhook/google` — receive Google Calendar push notifications.
///
/// # Protocol (Google Calendar Push Notifications)
///
/// Google sends a POST request with:
/// - `X-Goog-Channel-ID`      — the channel identifier we registered
/// - `X-Goog-Resource-ID`     — the watched resource
/// - `X-Goog-Resource-State`  — `"sync"` (channel confirmation) or `"exists"` (change notification)
/// - `X-Goog-Channel-Token`   — optional shared secret for verification
///
/// # Logic
///
/// 1. If webhook feature is disabled in config: return 200 (silently ignore).
/// 2. Validate `X-Goog-Channel-Token` if a token is configured.
/// 3. Look up the channel_id in `calendar_subscriptions.webhook_channel_json`.
/// 4. If not found: 404.
/// 5. If `resource_state == "sync"`: channel confirmation — return 200, no action.
/// 6. If `resource_state == "exists"`: enqueue `"calendar.googleDeltaSync"` job
///    with `account_id` so the sync worker can pick it up.
/// 7. Any other state: return 200 (forward compat).
#[instrument(skip_all)]
pub(crate) async fn calendar_google_webhook_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  // Feature flag: if webhooks are disabled, accept silently (don't expose info).
  if !state.config.calendar.google_webhook.enabled {
    debug!("google calendar webhook disabled in config, ignoring");
    return Ok(StatusCode::OK);
  }

  // Extract required headers.
  let channel_id = headers
    .get("x-goog-channel-id")
    .and_then(|v| v.to_str().ok())
    .map(str::trim)
    .filter(|v| !v.is_empty())
    .unwrap_or_default()
    .to_string();

  let resource_state = headers
    .get("x-goog-resource-state")
    .and_then(|v| v.to_str().ok())
    .map(str::trim)
    .unwrap_or("")
    .to_string();

  // Optional shared-secret validation.
  if let Some(expected_token) = state.config.calendar.google_webhook.token.as_deref() {
    let provided = headers
      .get("x-goog-channel-token")
      .and_then(|v| v.to_str().ok())
      .unwrap_or_default();
    if provided != expected_token {
      warn!(channel_id, "google calendar webhook: invalid channel token");
      return Ok(StatusCode::UNAUTHORIZED);
    }
  }

  if channel_id.is_empty() {
    debug!("google calendar webhook: missing X-Goog-Channel-ID, ignoring");
    return Ok(StatusCode::OK);
  }

  let calendar = match state.calendar() {
    Some(calendar) => calendar,
    None => {
      warn!(channel_id, "google calendar webhook: calendar service unavailable");
      return Ok(StatusCode::OK);
    }
  };

  let sub = calendar.subscription_by_channel_id(&channel_id).await.map_err(|e| {
    error!(channel_id, error = %e, "google calendar webhook: subscription lookup failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;

  let (sub_id, account_id) = match sub {
    Some(subscription) => (subscription.id, subscription.account_id),
    None => {
      // Unknown channel — might be stale or from another instance.
      info!(channel_id, "google calendar webhook: unknown channel_id");
      return Ok(StatusCode::NOT_FOUND);
    }
  };

  match resource_state.as_str() {
    "sync" => {
      // Channel confirmation from Google — no action needed.
      debug!(channel_id, %sub_id, "google calendar webhook: sync state confirmed");
    }
    "exists" => {
      // Change notification — enqueue a delta sync for this account.
      info!(channel_id, %account_id, "google calendar webhook: change notification, enqueueing delta sync");
      calendar.touch_subscription(sub_id).await.map_err(|e| {
        error!(channel_id, %account_id, error = %e, "google calendar webhook: failed to touch subscription");
        StatusCode::INTERNAL_SERVER_ERROR
      })?;

      // Enqueue the delta sync job into the google-calendar-sync queue.
      if let Some(redis_queue) = state.redis_queue() {
        let payload = serde_json::json!({ "accountId": account_id.to_string() });
        if let Err(e) = redis_queue
          .add_job("google-calendar-sync", "calendar.googleDeltaSync", payload, Some(3))
          .await
        {
          warn!(channel_id, %account_id, error = %e, "google calendar webhook: failed to enqueue delta sync");
        } else {
          debug!(channel_id, %account_id, "google calendar webhook: delta sync job enqueued");
        }
      } else {
        debug!(channel_id, %account_id, "google calendar webhook: no Redis queue available, skipping job enqueue");
      }
    }
    other => {
      debug!(
        channel_id,
        resource_state = other,
        "google calendar webhook: unhandled resource state, ignoring"
      );
    }
  }

  Ok(StatusCode::OK)
}

// ─── P90-CAL-E-09: Write REST endpoints ──────────────────────────────────────

#[derive(Debug, Default)]
enum CalendarSourceField {
  #[default]
  Missing,
  Null,
  Value(String),
}

impl<'de> Deserialize<'de> for CalendarSourceField {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    Ok(match Option::<String>::deserialize(deserializer)? {
      Some(value) => Self::Value(value),
      None => Self::Null,
    })
  }
}

/// Request body for `POST /calendar/events` and `PUT /calendar/events/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarEventBody {
  /// Stable local UUID for the event.  Generated if absent on create.
  pub id: Option<String>,
  /// The calendar account this event belongs to.
  pub account_id: String,
  /// Provider-assigned event UID (CalDAV / Google).
  pub remote_event_id: String,
  /// Event start time (UTC).
  pub starts_at: chrono::DateTime<chrono::Utc>,
  /// Event end time (UTC).
  pub ends_at: chrono::DateTime<chrono::Utc>,
  /// Event title.
  pub title: Option<String>,
  /// Canonical workspace-local external source document key.
  #[serde(default)]
  source_external_id: CalendarSourceField,
  /// Deprecated same-value alias for `sourceExternalId`.
  #[serde(default)]
  source_doc_id: CalendarSourceField,
  /// Optional remote calendar collection URL (CalDAV) or calendar ID (Google).
  ///
  /// When present, triggers write-back to the remote provider after local DB
  /// persistence.  Omit to skip remote write-back (local-only mode).
  #[serde(default)]
  pub remote_calendar_id: Option<String>,
}

fn calendar_source_external_id(
  source_external_id: CalendarSourceField,
  legacy_source_doc_id: CalendarSourceField,
) -> Result<Option<String>, StatusCode> {
  match (source_external_id, legacy_source_doc_id) {
    (CalendarSourceField::Missing, CalendarSourceField::Missing | CalendarSourceField::Null)
    | (CalendarSourceField::Null, CalendarSourceField::Missing) => Ok(None),
    (CalendarSourceField::Missing, CalendarSourceField::Value(value))
    | (CalendarSourceField::Value(value), CalendarSourceField::Missing) => Ok(Some(value)),
    _ => Err(StatusCode::BAD_REQUEST),
  }
}

async fn resolve_calendar_source_external_id(
  state: &ApiState,
  workspace_id: Uuid,
  source_external_id: Option<&str>,
) -> Result<Option<Uuid>, StatusCode> {
  let Some(source_external_id) = source_external_id else {
    return Ok(None);
  };
  let document_key = DocumentKey::parse(source_external_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  state
    .doc()
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(|error| {
      error!(%workspace_id, %error, "calendar REST source document resolution failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .map(Some)
    .ok_or(StatusCode::BAD_REQUEST)
}

/// Preserve the established REST event JSON while projecting the actor-facing
/// source document fields from internal UUID to one external key.
async fn map_calendar_events_rest(
  state: &ApiState,
  workspace_id: Uuid,
  events: Vec<CalendarEvent>,
) -> Result<Vec<serde_json::Value>, StatusCode> {
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
      .map_err(|error| {
        error!(%workspace_id, %error, "calendar REST source document projection failed");
        StatusCode::INTERNAL_SERVER_ERROR
      })?
  };

  events
    .into_iter()
    .map(|event| {
      let source_external_id = event
        .source_doc_id
        .and_then(|doc_id| external_ids.get(&doc_id).cloned());
      let mut value = serde_json::to_value(event).map_err(|error| {
        error!(%workspace_id, %error, "calendar REST event serialization failed");
        StatusCode::INTERNAL_SERVER_ERROR
      })?;
      let fields = value.as_object_mut().ok_or_else(|| {
        error!(%workspace_id, "calendar REST event did not serialize as an object");
        StatusCode::INTERNAL_SERVER_ERROR
      })?;
      fields.insert(
        "source_external_id".to_string(),
        source_external_id
          .clone()
          .map_or(serde_json::Value::Null, serde_json::Value::String),
      );
      fields.insert(
        "source_doc_id".to_string(),
        source_external_id.map_or(serde_json::Value::Null, serde_json::Value::String),
      );
      Ok(value)
    })
    .collect()
}

async fn map_calendar_event_rest(
  state: &ApiState,
  workspace_id: Uuid,
  event: CalendarEvent,
) -> Result<serde_json::Value, StatusCode> {
  map_calendar_events_rest(state, workspace_id, vec![event])
    .await?
    .pop()
    .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `POST /api/workspaces/{workspace_id}/calendar/events` — create a new event (P90-CAL-E-09).
#[instrument(skip_all)]
pub(crate) async fn create_calendar_event_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  headers: HeaderMap,
  Json(body): Json<CalendarEventBody>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  if body.ends_at < body.starts_at {
    return Err(StatusCode::UNPROCESSABLE_ENTITY);
  }
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;

  let calendar = state.calendar().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
  let account_uuid = Uuid::parse_str(&body.account_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let owns_account = calendar
    .list_accounts(snapshot.user.id)
    .await
    .map_err(|e| {
      error!(error = %e, "create_calendar_event_handler: list_accounts failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .into_iter()
    .any(|acc| acc.id == account_uuid);
  if !owns_account {
    return Err(StatusCode::FORBIDDEN);
  }
  let source_external_id = calendar_source_external_id(body.source_external_id, body.source_doc_id)?;
  let source_doc_uuid =
    resolve_calendar_source_external_id(&state, workspace_uuid, source_external_id.as_deref()).await?;

  let event_id = body
    .id
    .as_deref()
    .map(Uuid::parse_str)
    .transpose()
    .map_err(|_| StatusCode::BAD_REQUEST)?
    .unwrap_or_else(Uuid::new_v4);

  // Build remote write-back input when the caller supplies a remote_calendar_id.
  // TODO inv_cal_w06: integration test for REST write-back.
  let remote_input = body.remote_calendar_id.as_deref().map(|cal_id| RemoteEventInput {
    account_id: account_uuid,
    calendar_id: cal_id.to_string(),
    uid: body.remote_event_id.clone(),
    starts_at: body.starts_at,
    ends_at: body.ends_at,
    title: body.title.clone(),
    description: None,
    location: None,
    extra_payload: serde_json::json!({}),
  });

  let event = calendar
    .create_remote_event(
      CalendarEventUpsert {
        id: event_id,
        account_id: account_uuid,
        workspace_id: Some(workspace_uuid),
        remote_event_id: body.remote_event_id.clone(),
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        title: body.title.clone(),
        source_doc_id: source_doc_uuid,
        payload: serde_json::json!({}),
        participants: vec![],
        reminders: vec![],
      },
      remote_input,
    )
    .await
    .map_err(|e| {
      error!(workspace_id = %workspace_uuid, error = %e, "create_calendar_event_handler failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;

  info!(workspace_id = %workspace_uuid, event_id = %event.id, user_id = %snapshot.user.id, "REST: created calendar event");
  let event = map_calendar_event_rest(&state, workspace_uuid, event).await?;
  Ok((StatusCode::CREATED, Json(event)))
}

/// `PUT /api/workspaces/{workspace_id}/calendar/events/{event_id}` — update an event (P90-CAL-E-09).
#[instrument(skip_all)]
pub(crate) async fn update_calendar_event_handler(
  State(state): State<ApiState>,
  Path((workspace_id, event_id)): Path<(String, String)>,
  headers: HeaderMap,
  Json(body): Json<CalendarEventBody>,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let event_uuid = Uuid::parse_str(&event_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  if body.ends_at < body.starts_at {
    return Err(StatusCode::UNPROCESSABLE_ENTITY);
  }
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;

  let calendar = state.calendar().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
  let account_uuid = Uuid::parse_str(&body.account_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let owns_account = calendar
    .list_accounts(snapshot.user.id)
    .await
    .map_err(|e| {
      error!(error = %e, "update_calendar_event_handler: list_accounts failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .into_iter()
    .any(|acc| acc.id == account_uuid);
  if !owns_account {
    return Err(StatusCode::FORBIDDEN);
  }
  let source_external_id = calendar_source_external_id(body.source_external_id, body.source_doc_id)?;
  let source_doc_uuid =
    resolve_calendar_source_external_id(&state, workspace_uuid, source_external_id.as_deref()).await?;

  // Build remote write-back input when the caller supplies a remote_calendar_id.
  // TODO inv_cal_w06: integration test for REST write-back.
  let remote_input = body.remote_calendar_id.as_deref().map(|cal_id| RemoteEventInput {
    account_id: account_uuid,
    calendar_id: cal_id.to_string(),
    uid: body.remote_event_id.clone(),
    starts_at: body.starts_at,
    ends_at: body.ends_at,
    title: body.title.clone(),
    description: None,
    location: None,
    extra_payload: serde_json::json!({}),
  });

  let event = calendar
    .update_remote_event(
      CalendarEventUpsert {
        id: event_uuid,
        account_id: account_uuid,
        workspace_id: Some(workspace_uuid),
        remote_event_id: body.remote_event_id.clone(),
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        title: body.title.clone(),
        source_doc_id: source_doc_uuid,
        payload: serde_json::json!({}),
        participants: vec![],
        reminders: vec![],
      },
      remote_input,
    )
    .await
    .map_err(|e| {
      error!(workspace_id = %workspace_uuid, event_id = %event_uuid, error = %e, "update_calendar_event_handler failed");
      if e.to_string().contains("concurrently") {
        StatusCode::CONFLICT
      } else {
        StatusCode::INTERNAL_SERVER_ERROR
      }
    })?;

  info!(workspace_id = %workspace_uuid, event_id = %event_uuid, user_id = %snapshot.user.id, "REST: updated calendar event");
  let event = map_calendar_event_rest(&state, workspace_uuid, event).await?;
  Ok((StatusCode::OK, Json(event)))
}

/// `DELETE /api/workspaces/{workspace_id}/calendar/events/{event_id}` — delete an event (P90-CAL-E-09).
#[instrument(skip_all)]
pub(crate) async fn delete_calendar_event_handler(
  State(state): State<ApiState>,
  Path((workspace_id, event_id)): Path<(String, String)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let event_uuid = Uuid::parse_str(&event_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(|_| StatusCode::FORBIDDEN)?;

  let calendar = state.calendar().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
  let event = calendar.get_event(event_uuid).await.map_err(|e| {
    error!(event_id = %event_uuid, error = %e, "delete_calendar_event_handler: get_event failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  let Some(event) = event else {
    return Err(StatusCode::NOT_FOUND);
  };
  let owns_account = calendar
    .list_accounts(snapshot.user.id)
    .await
    .map_err(|e| {
      error!(error = %e, "delete_calendar_event_handler: list_accounts failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .into_iter()
    .any(|acc| Some(acc.id) == event.account_id);
  if !owns_account {
    return Err(StatusCode::FORBIDDEN);
  }

  calendar.delete_remote_event(event_uuid).await.map_err(|e| {
    error!(workspace_id = %workspace_uuid, event_id = %event_uuid, error = %e, "delete_calendar_event_handler failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;

  info!(workspace_id = %workspace_uuid, event_id = %event_uuid, user_id = %snapshot.user.id, "REST: deleted calendar event");
  Ok(StatusCode::NO_CONTENT)
}
