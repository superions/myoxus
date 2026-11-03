// SPDX-License-Identifier: AGPL-3.0-or-later
//! Google Calendar pull-sync service — infrastructure-layer orchestrator.
//!
//! [`GoogleCalendarSyncService`] fetches events from the Google Calendar API
//! for all enabled Google-type calendar accounts and upserts them into the
//! local PostgreSQL database using [`CalendarRepository`] directly.
//!
//! # Conflict policy
//!
//! V1 is **read-only** (Server-Wins): the Google Calendar API is the
//! authoritative source.  Every sync run overwrites local data with what
//! Google returns.  Local-only events (created via GraphQL) are not touched.
//!
//! # Sync algorithm
//!
//! 1. `list_google_accounts()` — all `calendar_accounts` with `provider = 'google'`.
//! 2. For each account, refresh the OAuth2 access token via
//!    [`refresh_google_access_token`].
//! 3. List subscriptions via `list_account_calendar_subscriptions(account_id)`.
//! 4. For each subscription:
//!    a. If a `sync_token` exists, attempt **incremental sync** (delta).
//!    b. If the sync token is expired (HTTP 410), fall back to **full sync**.
//!    c. Otherwise, perform a **full sync** with `time_min`/`time_max` window.
//! 5. Paginate via `nextPageToken` until all events are fetched.
//! 6. Upsert each event via `CalendarRepository::upsert_calendar_event`.
//! 7. Store the returned `syncToken` on the subscription for next run.
//!
//! # P72-B-03 DEFERRED
//!
//! Webhook push notifications (`Events.watch`) require a publicly reachable
//! HTTPS endpoint.  This is not available in selfhost V1.  All sync is
//! polling-based via the cron job scheduler.

use std::sync::Arc;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::ports::{PortResult, RedisPort};

use myoxus_domain::entities::{
  CalendarAccount, CalendarEvent, CalendarEventOrigin, CalendarEventParticipant, CalendarSubscription,
};
use myoxus_domain::repositories::CalendarRepository;

use super::{
  GoogleCalendarClient, GoogleCalendarError, GoogleEvent, GoogleEventAttendee, is_all_day, parse_google_datetime,
  refresh_google_access_token,
};
use crate::caldav::sync::CredentialDecryptor;
use crate::redis_lease::RedisLease;

const CALENDAR_SYNC_LEASE_TTL_SECONDS: u64 = 300;

/// Google returns content lines, not one RRULE value. Split supported EXDATE
/// lines before shared validation; unknown lines remain a preserved unsupported
/// source rather than silently disappearing from the imported series.
fn recurrence_source(lines: &[String], default_zone: &str) -> (Option<String>, Vec<String>, Vec<String>) {
  let mut rule = None;
  let mut dates = Vec::new();
  let mut instants = Vec::new();
  let parsed = (|| -> Option<()> {
    if lines.iter().map(String::len).sum::<usize>() > 8192 {
      return None;
    }
    for line in lines {
      let (name, value) = line.split_once(':')?;
      if name.eq_ignore_ascii_case("RRULE") {
        if rule.is_some() {
          return None;
        }
        rule = Some(value.to_owned());
        continue;
      }
      let mut parameters = name.split(';');
      if !parameters.next()?.eq_ignore_ascii_case("EXDATE") {
        return None;
      }
      let mut zone = default_zone;
      let mut date_only = false;
      for parameter in parameters {
        let (name, value) = parameter.split_once('=')?;
        if name.eq_ignore_ascii_case("TZID") {
          zone = value
        } else if name.eq_ignore_ascii_case("VALUE") && value.eq_ignore_ascii_case("DATE") {
          date_only = true
        } else if !(name.eq_ignore_ascii_case("VALUE") && value.eq_ignore_ascii_case("DATE-TIME")) {
          return None;
        }
      }
      for token in value.split(',') {
        if date_only {
          NaiveDate::parse_from_str(token, "%Y%m%d").ok()?;
          dates.push(token.to_owned());
        } else {
          let (token, utc) = token.strip_suffix('Z').map_or((token, false), |value| (value, true));
          let local = NaiveDateTime::parse_from_str(token, "%Y%m%dT%H%M%S").ok()?;
          let instant = if utc {
            local.and_utc()
          } else {
            zone
              .parse::<chrono_tz::Tz>()
              .ok()?
              .from_local_datetime(&local)
              .earliest()?
              .with_timezone(&Utc)
          };
          instants.push(instant.to_rfc3339());
        }
      }
    }
    Some(())
  })();
  if parsed.is_none() {
    return (Some(lines.join("\n")), vec![], vec![]);
  }
  (rule, dates, instants)
}

// ─── Sync result ─────────────────────────────────────────────────────────────

/// Summary of a single Google Calendar sync run.
#[derive(Debug, Clone, Default)]
pub struct GoogleCalendarSyncResult {
  /// Number of accounts visited.
  pub accounts_processed: u32,
  /// Number of subscriptions (individual calendars) synced.
  pub subscriptions_synced: u32,
  /// Total events upserted across all calendars.
  pub events_upserted: u32,
  /// Number of subscriptions that used incremental (syncToken) sync.
  pub incremental_syncs: u32,
  /// Number of subscriptions that required a full re-sync.
  pub full_syncs: u32,
  /// Per-account errors: `(account_id, error_message)`.
  pub errors: Vec<(Uuid, String)>,
}

// ─── Service ─────────────────────────────────────────────────────────────────

/// Infrastructure-layer Google Calendar pull-sync orchestrator.
///
/// Constructed once at startup and shared via `Arc`.  Each `run_sync` call
/// is fully idempotent.
#[derive(Clone)]
pub struct GoogleCalendarSyncService {
  repo: Arc<dyn CalendarRepository>,
  decryptor: Arc<dyn CredentialDecryptor>,
  lock_redis: Arc<dyn RedisPort>,
  /// Google OAuth2 client ID (from `oauth.google_client_id` config).
  google_client_id: String,
  /// Google OAuth2 client secret (from `oauth.google_client_secret` config).
  google_client_secret: String,
  /// How many days back to include in the full-sync time window.
  lookback_days: i64,
  /// How many days forward to include in the full-sync time window.
  lookahead_days: i64,
  additional_ca: Option<crate::tls::ValidatedCaBundle>,
}

impl GoogleCalendarSyncService {
  /// Create a new `GoogleCalendarSyncService`.
  ///
  /// * `google_client_id` / `google_client_secret` — OAuth2 credentials
  ///   for token refresh.
  /// * `lookback_days` — days in the past to include (default: 7).
  /// * `lookahead_days` — days in the future to include (default: 90).
  pub fn new(
    repo: Arc<dyn CalendarRepository>,
    decryptor: Arc<dyn CredentialDecryptor>,
    lock_redis: Arc<dyn RedisPort>,
    google_client_id: String,
    google_client_secret: String,
    lookback_days: i64,
    lookahead_days: i64,
    additional_ca: Option<crate::tls::ValidatedCaBundle>,
  ) -> Self {
    Self {
      repo,
      decryptor,
      lock_redis,
      google_client_id,
      google_client_secret,
      lookback_days,
      lookahead_days,
      additional_ca,
    }
  }

  /// Run one full pull-sync cycle for all Google Calendar accounts.
  ///
  /// Errors from individual accounts are collected and returned in the
  /// `errors` field. Technical lease errors abort the run before further
  /// provider or persistence side effects.
  #[instrument(skip(self))]
  pub async fn run_sync(&self) -> PortResult<GoogleCalendarSyncResult> {
    let mut result = GoogleCalendarSyncResult::default();
    let now = Utc::now();
    let time_min = now - Duration::days(self.lookback_days);
    let time_max = now + Duration::days(self.lookahead_days);

    let accounts = match self.repo.list_google_accounts().await {
      Ok(a) => a,
      Err(e) => {
        error!(error = %e, "google_cal_sync: failed to list Google accounts, aborting run");
        return Ok(result);
      }
    };

    info!(
      account_count = accounts.len(),
      %time_min, %time_max,
      "google_cal_sync: starting sync run"
    );

    for account in accounts {
      result.accounts_processed += 1;

      let lease_key = format!("calendar-sync:google:{}", account.id);
      let Some(lease) =
        RedisLease::acquire(Arc::clone(&self.lock_redis), lease_key, CALENDAR_SYNC_LEASE_TTL_SECONDS).await?
      else {
        warn!(account_id = %account.id, "google_cal_sync: sync already running for account, skipping");
        continue;
      };

      // Step 1: Decrypt the refresh token.
      let refresh_token = match self.get_refresh_token(&account) {
        Ok(rt) => rt,
        Err(e) => {
          warn!(
            account_id = %account.id,
            error = %e,
            "google_cal_sync: failed to get refresh token, skipping"
          );
          result.errors.push((account.id, e));
          continue;
        }
      };

      // Step 2: Refresh the access token (retry built into refresh_google_access_token).
      // After all retries fail, mark the account with a warning status instead
      // of silently skipping (P80-G-02).
      let token_resp = match refresh_google_access_token(
        &self.google_client_id,
        &self.google_client_secret,
        &refresh_token,
        self.additional_ca.as_ref(),
      )
      .await
      {
        Ok(tr) => tr,
        Err(e) => {
          error!(
            account_id = %account.id,
            error = %e,
            "google_cal_sync: token refresh failed after retries, marking account with warning"
          );
          // Mark the account with a warning status so the admin UI can surface it.
          let mut config = account.config.clone();
          config["sync_warning"] = serde_json::json!({
            "error": e.to_string(),
            "timestamp": Utc::now().to_rfc3339(),
            "type": "token_refresh_failed",
          });
          let warning_account = CalendarAccount {
            config,
            updated_at: Utc::now(),
            ..account.clone()
          };
          lease.ensure_owned()?;
          if let Err(update_err) = self.repo.update_calendar_account(&warning_account).await {
            warn!(
              account_id = %account.id,
              error = %update_err,
              "google_cal_sync: failed to persist warning status (non-fatal)"
            );
          }
          result.errors.push((account.id, e.to_string()));
          continue;
        }
      };

      // Step 3: Persist the new token expiry on the account and clear any
      // previous warning (P80-G-02).
      if let Some(expires_in) = token_resp.expires_in {
        let new_expires_at = Utc::now() + Duration::seconds(expires_in as i64);
        let mut config = account.config.clone();
        // Clear any previous sync_warning since refresh succeeded.
        if config.get("sync_warning").is_some() {
          config.as_object_mut().map(|m| m.remove("sync_warning"));
        }
        let updated_account = CalendarAccount {
          access_token_ciphertext: Some(token_resp.access_token.clone()),
          expires_at: Some(new_expires_at),
          config,
          updated_at: Utc::now(),
          ..account.clone()
        };
        lease.ensure_owned()?;
        if let Err(e) = self.repo.update_calendar_account(&updated_account).await {
          warn!(
            account_id = %account.id,
            error = %e,
            "google_cal_sync: failed to persist refreshed token (non-fatal)"
          );
        }
      }

      let client = match GoogleCalendarClient::new(token_resp.access_token, self.additional_ca.as_ref()) {
        Ok(c) => c,
        Err(e) => {
          warn!(account_id = %account.id, error = %e, "google_cal_sync: failed to build HTTP client, skipping");
          result.errors.push((account.id, e.to_string()));
          continue;
        }
      };

      // Step 4: List subscriptions for this account.
      let subscriptions = match self.repo.list_account_calendar_subscriptions(account.id).await {
        Ok(s) => s,
        Err(e) => {
          warn!(
            account_id = %account.id,
            error = %e,
            "google_cal_sync: failed to list subscriptions, skipping"
          );
          result.errors.push((account.id, e.to_string()));
          continue;
        }
      };

      debug!(
        account_id = %account.id,
        subscription_count = subscriptions.len(),
        "google_cal_sync: syncing account"
      );

      // Step 5: Sync each subscription.
      for sub in subscriptions {
        lease.ensure_owned()?;
        match self
          .sync_subscription(&client, &account, &sub, time_min, time_max, &lease)
          .await?
        {
          Ok((count, was_incremental)) => {
            result.subscriptions_synced += 1;
            result.events_upserted += count;
            if was_incremental {
              result.incremental_syncs += 1;
            } else {
              result.full_syncs += 1;
            }
          }
          Err(e) => {
            warn!(
              account_id = %account.id,
              calendar_id = %sub.remote_calendar_id,
              error = %e,
              "google_cal_sync: subscription sync failed"
            );
            result
              .errors
              .push((account.id, format!("calendar {}: {}", sub.remote_calendar_id, e)));
          }
        }
      }
    }

    info!(
      accounts = result.accounts_processed,
      subscriptions = result.subscriptions_synced,
      events = result.events_upserted,
      incremental = result.incremental_syncs,
      full = result.full_syncs,
      error_count = result.errors.len(),
      "google_cal_sync: sync run complete"
    );
    Ok(result)
  }

  /// Sync a single calendar subscription.
  ///
  /// Returns `(events_upserted, was_incremental)`.
  #[instrument(skip(self, client, lease), fields(account_id = %account.id, calendar_id = %sub.remote_calendar_id))]
  async fn sync_subscription(
    &self,
    client: &GoogleCalendarClient,
    account: &CalendarAccount,
    sub: &CalendarSubscription,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
    lease: &RedisLease,
  ) -> PortResult<Result<(u32, bool), String>> {
    let calendar_id = &sub.remote_calendar_id;

    // Attempt incremental sync if we have a sync token.
    if let Some(ref sync_token) = sub.sync_token {
      trace!(
        %calendar_id,
        sync_token = %sync_token,
        "google_cal_sync: attempting incremental sync"
      );

      match client.list_all_events(calendar_id, None, None, Some(sync_token)).await {
        Ok((events, new_sync_token)) => {
          let count = self.upsert_events(account, &events, lease).await?;
          self.update_sync_token(sub, new_sync_token, lease).await?;
          return Ok(Ok((count, true)));
        }
        Err(GoogleCalendarError::SyncTokenExpired) => {
          info!(
            %calendar_id,
            "google_cal_sync: sync token expired, falling back to full sync"
          );
          // Fall through to full sync below.
        }
        Err(e) => {
          return Ok(Err(format!("incremental sync: {e}")));
        }
      }
    }

    // Full sync with time window.
    trace!(
      %calendar_id,
      %time_min, %time_max,
      "google_cal_sync: performing full sync"
    );

    let (events, new_sync_token) = match client
      .list_all_events(calendar_id, Some(time_min), Some(time_max), None)
      .await
    {
      Ok(response) => response,
      Err(error) => return Ok(Err(format!("full sync: {error}"))),
    };

    let count = self.upsert_events(account, &events, lease).await?;
    self.update_sync_token(sub, new_sync_token, lease).await?;

    Ok(Ok((count, false)))
  }

  /// Upsert a batch of Google events into the database.
  ///
  /// Returns the number of events successfully upserted.
  async fn upsert_events(
    &self,
    account: &CalendarAccount,
    events: &[GoogleEvent],
    lease: &RedisLease,
  ) -> PortResult<u32> {
    let mut upserted = 0u32;
    let now = Utc::now();

    for event in events {
      // Skip events without a usable ID.
      let remote_event_id = event.ical_uid.as_deref().or(Some(&event.id)).unwrap_or(&event.id);

      // Parse start/end times.
      let starts_at = event.start.as_ref().and_then(parse_google_datetime).unwrap_or(now);
      let ends_at = event.end.as_ref().and_then(parse_google_datetime).unwrap_or(starts_at);

      let all_day = event.start.as_ref().map(is_all_day).unwrap_or(false);

      // Derive a deterministic event UUID from (account_id, remote_event_id).
      let event_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("google:{}:{}", account.id, remote_event_id).as_bytes(),
      );

      let zone = event
        .start
        .as_ref()
        .and_then(|s| s.time_zone.as_deref())
        .unwrap_or("UTC");
      let (rrule, exdate, exdates) = recurrence_source(event.recurrence.as_deref().unwrap_or_default(), zone);

      let payload = serde_json::json!({
        "provider": "google",
        "description": event.description,
        "location": event.location,
        "status": event.status,
        "rrule": rrule,
        "sourceRecurrence":event.recurrence,
        "exdate":exdate.join(","),
        "exdates":exdates,
        "recurringEventId": event.recurring_event_id,
        "originalTimezone": event.start.as_ref().and_then(|s| s.time_zone.clone()),
        "allDay": all_day,
        "googleEventId": event.id,
        "colorId": event.color_id,
        "visibility": event.visibility,
      });

      let bare_event = CalendarEvent {
        id: event_id,
        origin: CalendarEventOrigin::External,
        account_id: Some(account.id),
        workspace_id: None,
        remote_event_id: Some(remote_event_id.to_string()),
        starts_at,
        ends_at,
        title: event.summary.clone(),
        description: event.description.clone(),
        description_delta: None,
        location: event.location.clone(),
        source_doc_id: None,
        all_day,
        all_members: false,
        tag_id: None,
        recurrence_parent_id: None,
        participants: vec![],
        reminders: vec![],
        payload,
        updated_at: now,
        etag: None,
        remote_href: None,
      };

      lease.ensure_owned()?;
      match self.repo.upsert_calendar_event(&bare_event).await {
        Ok(_) => {}
        Err(e) => {
          warn!(
            remote_event_id = %remote_event_id,
            error = %e,
            "google_cal_sync: failed to upsert event, skipping"
          );
          // The page is not acknowledged until event and timing both commit.
          return Err(myoxus_application::ports::PortError::Transport(
            "calendar persistence unavailable".into(),
          ));
        }
      }

      // Upsert participants.
      let participants = self.build_participants(event_id, event, now);
      if !participants.is_empty() {
        lease.ensure_owned()?;
        if let Err(e) = self
          .repo
          .replace_calendar_event_participants(event_id, &participants)
          .await
        {
          warn!(
            remote_event_id = %remote_event_id,
            error = %e,
            "google_cal_sync: failed to replace participants (non-fatal)"
          );
        }
      }

      upserted += 1;
      trace!(
        remote_event_id = %remote_event_id,
        account_id = %account.id,
        "google_cal_sync: event upserted"
      );
    }

    Ok(upserted)
  }

  /// Build participant list from a Google event's organizer + attendees.
  fn build_participants(
    &self,
    event_id: Uuid,
    event: &GoogleEvent,
    now: DateTime<Utc>,
  ) -> Vec<CalendarEventParticipant> {
    let mut participants = Vec::new();

    // Add organizer if present and not already in attendees.
    if let Some(ref org) = event.organizer
      && let Some(ref email) = org.email
    {
      participants.push(self.attendee_to_participant(event_id, org, true, now));
      let _ = email; // suppress unused — email is used above in the push
    }

    // Add attendees.
    if let Some(ref attendees) = event.attendees {
      for att in attendees {
        // Skip if same email as organizer already added.
        let is_dup = att
          .email
          .as_ref()
          .is_some_and(|email| participants.iter().any(|p| p.email == *email));
        if is_dup {
          continue;
        }
        let is_org = att.organizer.unwrap_or(false);
        participants.push(self.attendee_to_participant(event_id, att, is_org, now));
      }
    }

    participants
  }

  /// Convert a Google attendee into a domain participant.
  fn attendee_to_participant(
    &self,
    event_id: Uuid,
    att: &GoogleEventAttendee,
    is_organizer: bool,
    now: DateTime<Utc>,
  ) -> CalendarEventParticipant {
    CalendarEventParticipant {
      id: Uuid::new_v4(),
      event_id,
      user_id: None,
      email: att.email.clone().unwrap_or_default(),
      display_name: att.display_name.clone(),
      response_status: att.response_status.clone().unwrap_or_else(|| "needsAction".to_string()),
      is_organizer,
      created_at: now,
      updated_at: now,
    }
  }

  /// Update the sync_token on a subscription after a successful sync.
  async fn update_sync_token(
    &self,
    sub: &CalendarSubscription,
    new_sync_token: Option<String>,
    lease: &RedisLease,
  ) -> PortResult<()> {
    let now = Utc::now();
    let updated_sub = CalendarSubscription {
      sync_token: new_sync_token.or_else(|| {
        // If no new sync token was returned, keep the timestamp-based
        // marker used by CalDAV sync for consistency.
        Some(now.to_rfc3339())
      }),
      updated_at: now,
      ..sub.clone()
    };
    lease.ensure_owned()?;
    if let Err(e) = self.repo.upsert_calendar_subscription(&updated_sub).await {
      warn!(
        calendar_id = %sub.remote_calendar_id,
        error = %e,
        "google_cal_sync: failed to update sync_token (non-fatal)"
      );
    }
    Ok(())
  }

  /// Extract and decrypt the refresh token from a Google calendar account.
  fn get_refresh_token(&self, account: &CalendarAccount) -> Result<String, String> {
    let enc_token = account
      .refresh_token_ciphertext
      .as_ref()
      .ok_or_else(|| "no refresh_token_ciphertext on Google account".to_string())?;
    self
      .decryptor
      .decrypt(enc_token)
      .map_err(|e| format!("refresh_token decrypt: {e}"))
  }
}

// ─── Channel renewal service (P90-CAL-B-03) ──────────────────────────────────

/// Summary of a single channel renewal run.
#[derive(Debug, Clone, Default)]
pub struct GoogleChannelRenewalResult {
  /// Number of subscriptions checked.
  pub checked: u32,
  /// Number of channels successfully renewed.
  pub renewed: u32,
  /// Per-subscription errors: `(subscription_id, error_message)`.
  pub errors: Vec<(Uuid, String)>,
}

/// Service that renews expiring Google Calendar push-notification channels.
///
/// Runs daily (cron: `calendar.renewGoogleChannels`).  For each subscription
/// whose `webhook_channel_json.expiry < now + 24h`, it:
/// 1. Calls `Events.stop` to deregister the old channel (best-effort).
/// 2. Calls `Events.watch` to register a fresh channel.
/// 3. Updates `webhook_channel_json` atomically in the DB.
#[derive(Clone)]
pub struct GoogleChannelRenewalService {
  repo: Arc<dyn CalendarRepository>,
  decryptor: Arc<dyn CredentialDecryptor>,
  google_client_id: String,
  google_client_secret: String,
  /// Base URL for the webhook callback (e.g. `https://my.server.com`).
  webhook_base_url: String,
  /// Optional shared secret sent as `token` in `Events.watch` registrations
  /// and validated by the webhook handler via `X-Goog-Channel-Token`.
  webhook_secret: Option<String>,
  additional_ca: Option<crate::tls::ValidatedCaBundle>,
}

impl GoogleChannelRenewalService {
  /// Create a new `GoogleChannelRenewalService`.
  pub fn new(
    repo: Arc<dyn CalendarRepository>,
    decryptor: Arc<dyn CredentialDecryptor>,
    google_client_id: String,
    google_client_secret: String,
    webhook_base_url: String,
    additional_ca: Option<crate::tls::ValidatedCaBundle>,
  ) -> Self {
    Self {
      repo,
      decryptor,
      google_client_id,
      google_client_secret,
      webhook_base_url,
      webhook_secret: None,
      additional_ca,
    }
  }

  /// Attach a webhook shared secret used to authenticate Google push notifications.
  pub fn with_webhook_secret(mut self, secret: Option<String>) -> Self {
    self.webhook_secret = secret;
    self
  }

  /// Run one renewal cycle: check subscriptions expiring within 24 hours and
  /// renew their watch channels.
  #[instrument(skip(self))]
  pub async fn run_renewal(&self) -> GoogleChannelRenewalResult {
    let mut result = GoogleChannelRenewalResult::default();

    let expiring = match self.repo.list_subscriptions_expiring_within(24).await {
      Ok(subs) => subs,
      Err(e) => {
        error!(error = %e, "google_channel_renewal: failed to list expiring subscriptions");
        return result;
      }
    };

    info!(
      count = expiring.len(),
      "google_channel_renewal: found subscriptions expiring within 24h"
    );

    for sub in expiring {
      result.checked += 1;
      let sub_id = sub.id;
      let account_id = sub.account_id;

      // Fetch the parent account to get the refresh token.
      let accounts = match self.repo.list_google_accounts().await {
        Ok(accs) => accs,
        Err(e) => {
          let msg = format!("failed to list google accounts: {e}");
          error!(error = %e, %sub_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
          continue;
        }
      };

      let account = match accounts.iter().find(|a| a.id == account_id) {
        Some(a) => a.clone(),
        None => {
          let msg = format!("parent account {account_id} not found for subscription {sub_id}");
          warn!(%sub_id, %account_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
          continue;
        }
      };

      // Decrypt refresh token and get a fresh access token.
      let refresh_token = match account.refresh_token_ciphertext.as_deref() {
        Some(enc) => match self.decryptor.decrypt(enc) {
          Ok(rt) => rt,
          Err(e) => {
            let msg = format!("decrypt refresh_token failed: {e}");
            warn!(%sub_id, %account_id, "google_channel_renewal: {}", msg);
            result.errors.push((sub_id, msg));
            continue;
          }
        },
        None => {
          let msg = "no refresh_token on account".to_string();
          warn!(%sub_id, %account_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
          continue;
        }
      };

      let token_resp = match refresh_google_access_token(
        &self.google_client_id,
        &self.google_client_secret,
        &refresh_token,
        self.additional_ca.as_ref(),
      )
      .await
      {
        Ok(t) => t,
        Err(e) => {
          let msg = format!("token refresh failed: {e}");
          warn!(%sub_id, %account_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
          continue;
        }
      };

      let client = match GoogleCalendarClient::new(token_resp.access_token.clone(), self.additional_ca.as_ref()) {
        Ok(c) => c,
        Err(e) => {
          let msg = format!("failed to build Google client: {e}");
          error!(%sub_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
          continue;
        }
      };

      // Stop the old channel (best-effort — ignore errors).
      if let Some(ref old_info) = sub.webhook_channel_json
        && let Err(e) = client.stop_channel(&old_info.channel_id, &old_info.resource_id).await
      {
        warn!(%sub_id, channel_id = %old_info.channel_id, error = %e,
            "google_channel_renewal: stop_channel failed (continuing anyway)");
      }

      // Register a new channel.
      let new_channel_id = Uuid::new_v4().to_string();
      let callback_url = format!(
        "{}/api/calendar/webhook/google",
        self.webhook_base_url.trim_end_matches('/')
      );

      match client
        .register_watch(
          &sub.remote_calendar_id,
          &new_channel_id,
          &callback_url,
          self.webhook_secret.as_deref(),
        )
        .await
      {
        Ok(watch_resp) => {
          let new_info = myoxus_domain::entities::WebhookChannelInfo {
            channel_id: watch_resp.channel_id.clone(),
            resource_id: watch_resp.resource_id.clone(),
            expiry: watch_resp.expiry,
          };
          if let Err(e) = self
            .repo
            .update_subscription_webhook_channel(sub_id, Some(&new_info))
            .await
          {
            let msg = format!("DB update failed: {e}");
            error!(%sub_id, "google_channel_renewal: {}", msg);
            result.errors.push((sub_id, msg));
          } else {
            info!(
              %sub_id,
              new_channel_id = %watch_resp.channel_id,
              expiry = ?watch_resp.expiry,
              "google_channel_renewal: channel renewed"
            );
            result.renewed += 1;
          }
        }
        Err(e) => {
          let msg = format!("register_watch failed: {e}");
          warn!(%sub_id, "google_channel_renewal: {}", msg);
          result.errors.push((sub_id, msg));
        }
      }
    }

    info!(
      checked = result.checked,
      renewed = result.renewed,
      errors = result.errors.len(),
      "google_channel_renewal: run complete"
    );
    result
  }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::caldav::sync::PlaintextCredentialDecryptor;
  use crate::calendar::test_support::NullCalendarRepository;
  use crate::redis::InMemoryRedisAdapter;

  fn test_lock_redis() -> Arc<dyn RedisPort> {
    Arc::new(InMemoryRedisAdapter::new("google-calendar-sync-test"))
  }

  #[test]
  fn recurrence_content_lines_preserve_rule_limits_and_zoned_exclusions() {
    let lines = vec![
      "RRULE:FREQ=WEEKLY;COUNT=4".to_owned(),
      "EXDATE;TZID=Europe/Berlin:20310330T090000".to_owned(),
    ];
    assert_eq!(
      recurrence_source(&lines, "Europe/Berlin"),
      (
        Some("FREQ=WEEKLY;COUNT=4".to_owned()),
        vec![],
        vec!["2031-03-30T07:00:00+00:00".to_owned()]
      )
    );
    let unsupported = vec![lines[0].clone(), "RDATE:20310401T070000Z".to_owned()];
    assert_eq!(
      recurrence_source(&unsupported, "UTC"),
      (Some(unsupported.join("\n")), vec![], vec![]),
      "unsupported content must remain a complete source, never a silently weakened RRULE"
    );
  }

  #[test]
  fn get_refresh_token_success() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = GoogleCalendarSyncService::new(
      repo,
      dec,
      test_lock_redis(),
      "client-id".to_string(),
      "client-secret".to_string(),
      7,
      90,
      None,
    );

    let account = make_google_account("test-refresh-token");
    let token = svc.get_refresh_token(&account).unwrap();
    assert_eq!(token, "test-refresh-token");
  }

  #[test]
  fn get_refresh_token_missing_returns_err() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = GoogleCalendarSyncService::new(
      repo,
      dec,
      test_lock_redis(),
      "client-id".to_string(),
      "client-secret".to_string(),
      7,
      90,
      None,
    );

    let mut account = make_google_account("token");
    account.refresh_token_ciphertext = None;
    assert!(svc.get_refresh_token(&account).is_err());
  }

  #[test]
  fn build_participants_organizer_and_attendees() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = GoogleCalendarSyncService::new(
      repo,
      dec,
      test_lock_redis(),
      "cid".to_string(),
      "csec".to_string(),
      7,
      90,
      None,
    );

    let event = GoogleEvent {
      id: "ev1".to_string(),
      etag: None,
      status: Some("confirmed".to_string()),
      summary: Some("Meeting".to_string()),
      description: None,
      location: None,
      start: None,
      end: None,
      organizer: Some(GoogleEventAttendee {
        email: Some("org@example.com".to_string()),
        display_name: Some("Organizer".to_string()),
        response_status: Some("accepted".to_string()),
        organizer: Some(true),
        is_self: None,
      }),
      attendees: Some(vec![
        GoogleEventAttendee {
          email: Some("org@example.com".to_string()),
          display_name: Some("Organizer".to_string()),
          response_status: Some("accepted".to_string()),
          organizer: Some(true),
          is_self: None,
        },
        GoogleEventAttendee {
          email: Some("attendee@example.com".to_string()),
          display_name: Some("Attendee".to_string()),
          response_status: Some("tentative".to_string()),
          organizer: None,
          is_self: None,
        },
      ]),
      recurrence: None,
      recurring_event_id: None,
      ical_uid: None,
      updated: None,
      color_id: None,
      visibility: None,
    };

    let now = Utc::now();
    let event_id = Uuid::new_v4();
    let participants = svc.build_participants(event_id, &event, now);

    // Organizer should appear once (deduped from attendees list).
    assert_eq!(participants.len(), 2);
    assert!(participants[0].is_organizer);
    assert_eq!(participants[0].email, "org@example.com");
    assert!(!participants[1].is_organizer);
    assert_eq!(participants[1].email, "attendee@example.com");
  }

  #[test]
  fn build_participants_no_attendees() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = GoogleCalendarSyncService::new(
      repo,
      dec,
      test_lock_redis(),
      "cid".to_string(),
      "csec".to_string(),
      7,
      90,
      None,
    );

    let event = GoogleEvent {
      id: "ev2".to_string(),
      etag: None,
      status: None,
      summary: None,
      description: None,
      location: None,
      start: None,
      end: None,
      organizer: None,
      attendees: None,
      recurrence: None,
      recurring_event_id: None,
      ical_uid: None,
      updated: None,
      color_id: None,
      visibility: None,
    };

    let participants = svc.build_participants(Uuid::new_v4(), &event, Utc::now());
    assert!(participants.is_empty());
  }

  #[test]
  fn upsert_event_deterministic_id() {
    // Verify that the same account_id + remote_event_id always produces the same UUID.
    let account_id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
    let remote_event_id = "unique-ical-uid@google.com";

    let id1 = Uuid::new_v5(
      &Uuid::NAMESPACE_URL,
      format!("google:{}:{}", account_id, remote_event_id).as_bytes(),
    );
    let id2 = Uuid::new_v5(
      &Uuid::NAMESPACE_URL,
      format!("google:{}:{}", account_id, remote_event_id).as_bytes(),
    );
    assert_eq!(id1, id2, "deterministic UUID should be stable");

    // Different remote_event_id → different UUID.
    let id3 = Uuid::new_v5(
      &Uuid::NAMESPACE_URL,
      format!("google:{}:other-uid@google.com", account_id).as_bytes(),
    );
    assert_ne!(id1, id3, "different remote_event_id should produce different UUID");
  }

  #[test]
  fn sync_result_default_is_zero() {
    let result = GoogleCalendarSyncResult::default();
    assert_eq!(result.accounts_processed, 0);
    assert_eq!(result.subscriptions_synced, 0);
    assert_eq!(result.events_upserted, 0);
    assert_eq!(result.incremental_syncs, 0);
    assert_eq!(result.full_syncs, 0);
    assert!(result.errors.is_empty());
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  fn make_google_account(refresh_token: &str) -> CalendarAccount {
    let now = Utc::now();
    CalendarAccount {
      id: Uuid::new_v4(),
      user_id: Uuid::new_v4(),
      provider: "google".to_string(),
      remote_account_id: "user@gmail.com".to_string(),
      access_token_ciphertext: None,
      refresh_token_ciphertext: Some(refresh_token.to_string()),
      expires_at: None,
      config: serde_json::json!({}),
      created_at: now,
      updated_at: now,
    }
  }
}
