// SPDX-License-Identifier: AGPL-3.0-or-later
//! CalDAV pull-sync service — infrastructure-layer orchestrator.
//!
//! [`CalDavSyncService`] fetches events from CalDAV servers for all enabled
//! CalDAV calendar accounts and upserts them into the local PostgreSQL database
//! using [`CalendarRepository`] directly.
//!
//! # Conflict policy
//!
//! V1 is **read-only** (Server-Wins): the CalDAV remote is the authoritative
//! source.  Every sync run overwrites local data with what the server returns.
//! Local-only events (created via the GraphQL mutation) are not touched.
//!
//! # Sync algorithm
//!
//! 1. `list_caldav_accounts()` — all `calendar_accounts` with `provider = 'caldav'`.
//! 2. For each account, `list_account_calendar_subscriptions(account_id)`.
//! 3. For each subscription, `CalDavClient::fetch_events(from, to)`.
//! 4. Parse each iCalendar payload with `parse_ical_events`.
//! 5. Upsert each event via `CalendarRepository::upsert_calendar_event`.
//! 6. **Instance materialization** (P90-CAL-C-04): if the event has an RRULE,
//!    expand occurrences for `INSTANCE_HORIZON_DAYS` days ahead and upsert them
//!    into `calendar_event_instances`.  For RECURRENCE-ID events, create override
//!    instances.  On re-sync, non-override instances are deleted and re-expanded.
//! 7. Update `sync_token` on the subscription to record a successful sync time.
//!
//! # Instance expansion horizon
//!
//! Controlled by [`INSTANCE_HORIZON_DAYS`] (default 180 days = 6 months).  This
//! constant can be replaced with a config value in a future iteration.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use tracing::{debug, error, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::ports::{PortResult, RedisPort};

/// How many days ahead to expand RRULE instances during a sync run.
/// Default: 180 days (≈ 6 months).
pub const INSTANCE_HORIZON_DAYS: i64 = 180;
const CALENDAR_SYNC_LEASE_TTL_SECONDS: u64 = 300;

struct InstanceMaterialization<'a> {
  event_id: Uuid,
  rrule: &'a Option<String>,
  recurrence_id: &'a Option<String>,
  starts_at: DateTime<Utc>,
  ends_at: DateTime<Utc>,
  now: DateTime<Utc>,
  horizon: DateTime<Utc>,
}

/// In-memory cache of the last-seen ctag per calendar (keyed by
/// `"{account_id}:{remote_calendar_id}"`). Persists across sync runs within
/// the same process lifetime. Avoids re-fetching all events when the remote
/// calendar has not changed.
static CALDAV_CTAG_CACHE: std::sync::LazyLock<DashMap<String, String>> = std::sync::LazyLock::new(DashMap::new);

use myoxus_domain::entities::{
  CalendarAccount, CalendarEvent, CalendarEventInstance, CalendarEventOrigin, CalendarEventParticipant,
  CalendarSubscription,
};
use myoxus_domain::repositories::CalendarRepository;

use super::rrule::expand_rrule;
use super::{CalDavClient, CalDavCredential, ParsedVEvent, parse_ical_events};
use crate::redis_lease::RedisLease;

// ─── Credential decryptor port ────────────────────────────────────────────────

/// Port trait for decrypting encrypted credential blobs stored in
/// `calendar_accounts.access_token_ciphertext`.
///
/// The application layer defines this abstraction; infrastructure provides the
/// AES-GCM backed implementation.
pub trait CredentialDecryptor: Send + Sync {
  /// Decrypt `ciphertext` and return the plaintext credential string.
  fn decrypt(&self, ciphertext: &str) -> Result<String, String>;
}

/// Pass-through decryptor that returns the input unchanged.
///
/// Used in unit tests and when the credentials are stored in plaintext
/// (development mode only — never production).
pub struct PlaintextCredentialDecryptor;

impl CredentialDecryptor for PlaintextCredentialDecryptor {
  fn decrypt(&self, ciphertext: &str) -> Result<String, String> {
    Ok(ciphertext.to_string())
  }
}

// ─── Sync result ──────────────────────────────────────────────────────────────

/// Summary of a single CalDAV sync run.
#[derive(Debug, Clone, Default)]
pub struct CalDavSyncResult {
  /// Number of accounts visited.
  pub accounts_processed: u32,
  /// Number of subscriptions (individual calendars) synced.
  pub subscriptions_synced: u32,
  /// Total events upserted across all calendars.
  pub events_upserted: u32,
  /// Total recurrence instances materialized across all events.
  pub instances_materialized: u32,
  /// Number of events skipped due to parse errors (missing UID, bad DTSTART, etc.).
  pub skipped_events: u32,
  /// Number of subscriptions skipped because ctag was unchanged.
  pub ctag_skipped: u32,
  /// Per-account errors: `(account_id, error_message)`.
  pub errors: Vec<(Uuid, String)>,
}

// ─── Service ──────────────────────────────────────────────────────────────────

/// Infrastructure-layer CalDAV pull-sync orchestrator.
///
/// Constructed once at startup and shared via `Arc`.  Each `run_sync` call is
/// fully idempotent.
#[derive(Clone)]
pub struct CalDavSyncService {
  repo: Arc<dyn CalendarRepository>,
  decryptor: Arc<dyn CredentialDecryptor>,
  lock_redis: Arc<dyn RedisPort>,
  /// How many days back to include in the sync time window.
  lookback_days: i64,
  /// How many days forward to include in the sync time window.
  lookahead_days: i64,
  additional_ca: Option<crate::tls::ValidatedCaBundle>,
}

impl CalDavSyncService {
  /// Create a new `CalDavSyncService`.
  ///
  /// * `lookback_days` — days in the past to include (default: 7).
  /// * `lookahead_days` — days in the future to include (default: 90).
  pub fn new(
    repo: Arc<dyn CalendarRepository>,
    decryptor: Arc<dyn CredentialDecryptor>,
    lock_redis: Arc<dyn RedisPort>,
    lookback_days: i64,
    lookahead_days: i64,
    additional_ca: Option<crate::tls::ValidatedCaBundle>,
  ) -> Self {
    Self {
      repo,
      decryptor,
      lock_redis,
      lookback_days,
      lookahead_days,
      additional_ca,
    }
  }

  /// Run one full pull-sync cycle for all CalDAV accounts.
  ///
  /// Errors from individual accounts are collected and returned in the
  /// `errors` field. Technical lease errors abort the run before further
  /// provider or persistence side effects.
  #[instrument(skip(self))]
  pub async fn run_sync(&self) -> PortResult<CalDavSyncResult> {
    let mut result = CalDavSyncResult::default();
    let now = Utc::now();
    let from = now - Duration::days(self.lookback_days);
    let to = now + Duration::days(self.lookahead_days);

    let accounts = match self.repo.list_caldav_accounts().await {
      Ok(a) => a,
      Err(e) => {
        error!(error = %e, "caldav_sync: failed to list CalDAV accounts, aborting run");
        return Ok(result);
      }
    };

    info!(account_count = accounts.len(), %from, %to, "caldav_sync: starting sync run");

    for account in accounts {
      result.accounts_processed += 1;

      let lease_key = format!("calendar-sync:caldav:{}", account.id);
      let Some(lease) =
        RedisLease::acquire(Arc::clone(&self.lock_redis), lease_key, CALENDAR_SYNC_LEASE_TTL_SECONDS).await?
      else {
        warn!(account_id = %account.id, "caldav_sync: sync already running for account, skipping");
        continue;
      };

      let credential = match self.build_credential(&account) {
        Ok(c) => c,
        Err(e) => {
          warn!(account_id = %account.id, error = %e, "caldav_sync: credential build failed, skipping");
          result.errors.push((account.id, e));
          continue;
        }
      };

      let base_url = match account.config.get("caldavUrl").and_then(|v| v.as_str()) {
        Some(u) => u.to_string(),
        None => {
          warn!(account_id = %account.id, "caldav_sync: no caldavUrl in account config, skipping");
          result
            .errors
            .push((account.id, "missing caldavUrl in account config".to_string()));
          continue;
        }
      };

      let client = match CalDavClient::new(base_url.clone(), credential, self.additional_ca.as_ref()) {
        Ok(c) => c,
        Err(e) => {
          warn!(account_id = %account.id, error = %e, "caldav_sync: failed to build HTTP client, skipping");
          result.errors.push((account.id, e.to_string()));
          continue;
        }
      };

      // ── RFC 6638 scheduling capabilities detection (P90-CAL-B-04) ─────────
      // Run once per account when the `scheduling` key is absent from config.
      // Stores the result back into `account.config` JSONB.
      if account.config.get("scheduling").is_none() {
        let cred_for_caps = match self.build_credential(&account) {
          Ok(c) => c,
          Err(_) => self
            .build_credential(&account)
            .unwrap_or(crate::caldav::CalDavCredential::Basic {
              username: String::new(),
              password: String::new(),
            }),
        };
        match client.detect_scheduling_capabilities(&base_url, &cred_for_caps).await {
          Ok(caps) => {
            // Merge capabilities into the account config and persist.
            let mut updated_config = account.config.clone();
            if let Some(obj) = updated_config.as_object_mut() {
              obj.insert(
                "scheduling".to_string(),
                serde_json::to_value(&caps).unwrap_or(serde_json::Value::Null),
              );
            }
            let mut updated_account = account.clone();
            updated_account.config = updated_config;
            updated_account.updated_at = chrono::Utc::now();
            lease.ensure_owned()?;
            if let Err(e) = self.repo.update_calendar_account(&updated_account).await {
              debug!(account_id = %account.id, error = %e,
                "caldav_sync: failed to save scheduling capabilities (non-fatal)");
            } else {
              debug!(account_id = %account.id, rfc6638 = caps.rfc6638,
                "caldav_sync: scheduling capabilities detected and saved");
            }
          }
          Err(e) => {
            debug!(account_id = %account.id, error = %e,
              "caldav_sync: scheduling capabilities detection failed (non-fatal)");
          }
        }
      }

      // ── ctag optimisation (P80-G-06) ─────────────────────────────────────
      // Before fetching events, discover calendars and compare ctags.
      // If ctag is unchanged, skip the expensive REPORT fetch.
      let remote_calendars = match client.discover_calendars().await {
        Ok(cals) => cals,
        Err(e) => {
          debug!(account_id = %account.id, error = %e, "caldav_sync: calendar discovery failed, proceeding without ctag check");
          vec![]
        }
      };

      let subscriptions = match self.repo.list_account_calendar_subscriptions(account.id).await {
        Ok(s) => s,
        Err(e) => {
          warn!(account_id = %account.id, error = %e, "caldav_sync: failed to list subscriptions, skipping");
          result.errors.push((account.id, e.to_string()));
          continue;
        }
      };

      debug!(
        account_id = %account.id,
        subscription_count = subscriptions.len(),
        "caldav_sync: syncing account"
      );

      for sub in subscriptions {
        lease.ensure_owned()?;
        // Check ctag: if we have a cached ctag and the remote ctag matches, skip.
        let ctag_cache_key = format!("{}:{}", account.id, sub.remote_calendar_id);
        let remote_ctag = remote_calendars
          .iter()
          .find(|c| c.href == sub.remote_calendar_id)
          .and_then(|c| c.ctag.as_deref());

        if let Some(current_ctag) = remote_ctag
          && let Some(cached) = CALDAV_CTAG_CACHE.get(&ctag_cache_key)
          && cached.value() == current_ctag
        {
          debug!(
            account_id = %account.id,
            calendar_id = %sub.remote_calendar_id,
            ctag = %current_ctag,
            "caldav_sync: ctag unchanged, skipping fetch"
          );
          result.ctag_skipped += 1;
          result.subscriptions_synced += 1;
          continue;
        }

        match self
          .sync_subscription(&client, &account, &sub, from, to, &lease)
          .await?
        {
          Ok((upserted, skipped, instances)) => {
            result.subscriptions_synced += 1;
            result.events_upserted += upserted;
            result.skipped_events += skipped;
            result.instances_materialized += instances;

            // Update ctag cache after successful sync.
            if let Some(new_ctag) = remote_ctag {
              lease.ensure_owned()?;
              CALDAV_CTAG_CACHE.insert(ctag_cache_key, new_ctag.to_string());
            }
          }
          Err(e) => {
            warn!(
              account_id = %account.id,
              calendar_id = %sub.remote_calendar_id,
              error = %e,
              "caldav_sync: subscription sync failed"
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
      instances = result.instances_materialized,
      skipped = result.skipped_events,
      ctag_skipped = result.ctag_skipped,
      error_count = result.errors.len(),
      "caldav_sync: sync run complete"
    );
    Ok(result)
  }

  /// Sync a single calendar subscription.
  ///
  /// Returns `(events_upserted, events_skipped, instances_materialized)`.
  #[instrument(skip(self, client, lease), fields(account_id = %account.id, calendar_id = %sub.remote_calendar_id))]
  async fn sync_subscription(
    &self,
    client: &CalDavClient,
    account: &CalendarAccount,
    sub: &CalendarSubscription,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    lease: &RedisLease,
  ) -> PortResult<Result<(u32, u32, u32), String>> {
    // Use the structured REPORT parser so we get ETags alongside iCal data.
    let report_items = match client.fetch_events_with_etags(&sub.remote_calendar_id, from, to).await {
      Ok(items) => items,
      Err(error) => return Ok(Err(format!("fetch_events_with_etags: {error}"))),
    };

    trace!(
      ical_count = report_items.len(),
      "caldav_sync: fetched iCal items (with ETags)"
    );

    let mut upserted = 0u32;
    let mut skipped = 0u32;
    let mut instances_materialized = 0u32;
    let now = Utc::now();
    // Upper bound for instance expansion: now + horizon.
    let instance_horizon = now + Duration::days(INSTANCE_HORIZON_DAYS);

    for item in &report_items {
      let ical = &item.ical;
      let item_href = item.href.clone();
      let item_etag = item.etag.clone();
      let parsed = parse_ical_events(ical);
      if parsed.is_empty() {
        // The iCal block contained no parseable VEVENTs — count as skipped.
        skipped += 1;
        warn!(
          account_id = %account.id,
          calendar_id = %sub.remote_calendar_id,
          "caldav_sync: iCal block contained no parseable events, skipping"
        );
      }
      for pev in parsed {
        // Destructure fields that are needed multiple times to avoid clones.
        let ParsedVEvent {
          uid,
          summary,
          starts_at,
          ends_at,
          description,
          location,
          status,
          rrule,
          recurrence_id,
          original_timezone,
          all_day,
          organizer_email,
          attendees,
        } = pev;

        // Derive a deterministic event UUID from (account_id, uid).
        let event_id = Uuid::new_v5(
          &Uuid::NAMESPACE_URL,
          format!("caldav:{}:{}", account.id, uid).as_bytes(),
        );

        let payload = serde_json::json!({
          "provider": "caldav",
          "description": description,
          "location": location,
          "status": status,
          "rrule": rrule,
          "recurrenceId": recurrence_id,
          "originalTimezone": original_timezone,
          "allDay": all_day,
        });

        let bare_event = CalendarEvent {
          id: event_id,
          origin: CalendarEventOrigin::External,
          account_id: Some(account.id),
          // workspace_id is not set during background sync — events are
          // associated to workspaces via WorkspaceCalendar records managed
          // through the GraphQL layer.
          workspace_id: None,
          remote_event_id: Some(uid.clone()),
          starts_at,
          ends_at,
          title: summary,
          description: description.clone(),
          description_delta: None,
          location: location.clone(),
          source_doc_id: None,
          all_day: false,
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
          Ok(_) => {
            // Persist ETag + href so write-back can use optimistic locking.
            if let Some(ref etag) = item_etag {
              lease.ensure_owned()?;
              if let Err(e) = self.repo.update_event_etag(event_id, etag, &item_href).await {
                warn!(uid = %uid, error = %e, "caldav_sync: failed to store ETag (non-fatal)");
              } else {
                trace!(uid = %uid, etag = %etag, href = %item_href, "caldav_sync: ETag persisted");
              }
            }
          }
          Err(e) => {
            warn!(uid = %uid, error = %e, "caldav_sync: failed to upsert event, skipping");
            continue;
          }
        }

        // Upsert participants.
        let mut participants: Vec<CalendarEventParticipant> = Vec::new();
        if let Some(org_email) = organizer_email {
          participants.push(CalendarEventParticipant {
            id: Uuid::new_v4(),
            event_id,
            user_id: None,
            email: org_email,
            display_name: None,
            response_status: "accepted".to_string(),
            is_organizer: true,
            created_at: now,
            updated_at: now,
          });
        }
        for att in attendees {
          participants.push(CalendarEventParticipant {
            id: Uuid::new_v4(),
            event_id,
            user_id: None,
            email: att.email,
            display_name: att.display_name,
            response_status: att.rsvp_status,
            is_organizer: att.is_organizer,
            created_at: now,
            updated_at: now,
          });
        }

        if !participants.is_empty() {
          lease.ensure_owned()?;
          if let Err(e) = self
            .repo
            .replace_calendar_event_participants(event_id, &participants)
            .await
          {
            warn!(uid = %uid, error = %e, "caldav_sync: failed to replace participants (non-fatal)");
          }
        }

        upserted += 1;
        trace!(uid = %uid, account_id = %account.id, "caldav_sync: event upserted");

        // ── P90-CAL-C-04: Instance materialization ─────────────────────────
        // Expand RRULE into concrete instances for the next INSTANCE_HORIZON_DAYS.
        // For RECURRENCE-ID override events: create a single is_override instance.
        instances_materialized += self
          .materialize_instances(
            InstanceMaterialization {
              event_id,
              rrule: &rrule,
              recurrence_id: &recurrence_id,
              starts_at,
              ends_at,
              now,
              horizon: instance_horizon,
            },
            lease,
          )
          .await?;
      }
    }

    // Update sync_token with current timestamp to track last-successful-sync.
    let updated_sub = CalendarSubscription {
      sync_token: Some(now.to_rfc3339()),
      updated_at: now,
      ..sub.clone()
    };
    lease.ensure_owned()?;
    if let Err(e) = self.repo.upsert_calendar_subscription(&updated_sub).await {
      warn!(
        calendar_id = %sub.remote_calendar_id,
        error = %e,
        "caldav_sync: failed to update sync_token (non-fatal)"
      );
    }

    if skipped > 0 {
      warn!(
        account_id = %account.id,
        calendar_id = %sub.remote_calendar_id,
        skipped_events = skipped,
        "caldav_sync: some events were skipped due to parse errors"
      );
    }

    Ok(Ok((upserted, skipped, instances_materialized)))
  }

  /// Expand RRULE instances for a single event and upsert them.
  ///
  /// For RECURRENCE-ID override events (`recurrence_id.is_some()`): create a
  /// single `is_override = true` instance at the event's concrete start/end.
  ///
  /// For master recurring events (`rrule.is_some()`): delete existing non-override
  /// instances for this event, then expand and upsert fresh instances.
  ///
  /// Returns the number of instances upserted.
  #[instrument(skip(self, params, lease), fields(event_id = %params.event_id))]
  async fn materialize_instances(&self, params: InstanceMaterialization<'_>, lease: &RedisLease) -> PortResult<u32> {
    let InstanceMaterialization {
      event_id,
      rrule,
      recurrence_id,
      starts_at,
      ends_at,
      now,
      horizon,
    } = params;
    // Case 1: RECURRENCE-ID override (a specific occurrence was modified/cancelled).
    if recurrence_id.is_some() {
      let instance = CalendarEventInstance {
        id: Uuid::new_v5(
          &Uuid::NAMESPACE_URL,
          format!("caldav-override:{}:{}", event_id, starts_at.timestamp()).as_bytes(),
        ),
        event_id,
        instance_start: starts_at,
        instance_end: ends_at,
        is_override: true,
        is_cancelled: false,
        override_payload: None,
        created_at: now,
      };
      lease.ensure_owned()?;
      match self.repo.upsert_event_instance(&instance).await {
        Ok(_) => {
          trace!(event_id = %event_id, instance_start = %starts_at, "caldav_sync: override instance upserted");
          return Ok(1);
        }
        Err(e) => {
          warn!(event_id = %event_id, error = %e, "caldav_sync: failed to upsert override instance (non-fatal)");
          return Ok(0);
        }
      }
    }

    // Case 2: Master recurring event with RRULE.
    let rrule_str = match rrule {
      Some(r) if !r.is_empty() => r.as_str(),
      _ => return Ok(0), // no RRULE — non-recurring event, no instances to create
    };

    // Delete existing non-override instances before re-expanding.
    lease.ensure_owned()?;
    if let Err(e) = self.repo.delete_event_instances_by_event(event_id).await {
      warn!(event_id = %event_id, error = %e, "caldav_sync: failed to delete old instances (non-fatal)");
    }

    let duration = ends_at - starts_at;
    let occurrences = expand_rrule(rrule_str, starts_at, duration, now, horizon, &[]);

    let mut count = 0u32;
    for (occ_start, occ_end) in occurrences {
      let instance = CalendarEventInstance {
        id: Uuid::new_v5(
          &Uuid::NAMESPACE_URL,
          format!("caldav-instance:{}:{}", event_id, occ_start.timestamp()).as_bytes(),
        ),
        event_id,
        instance_start: occ_start,
        instance_end: occ_end,
        is_override: false,
        is_cancelled: false,
        override_payload: None,
        created_at: now,
      };
      lease.ensure_owned()?;
      match self.repo.upsert_event_instance(&instance).await {
        Ok(_) => {
          count += 1;
          trace!(event_id = %event_id, instance_start = %occ_start, "caldav_sync: instance upserted");
        }
        Err(e) => {
          warn!(event_id = %event_id, instance_start = %occ_start, error = %e, "caldav_sync: failed to upsert instance (non-fatal)");
        }
      }
    }
    debug!(event_id = %event_id, instances = count, "caldav_sync: instances materialized");
    Ok(count)
  }

  /// Build a [`CalDavCredential`] from a [`CalendarAccount`].
  ///
  /// - `access_token_ciphertext` → Basic-Auth password (decrypted).
  /// - `refresh_token_ciphertext` → Bearer token (decrypted) if no password.
  fn build_credential(&self, account: &CalendarAccount) -> Result<CalDavCredential, String> {
    if let Some(ref enc_pw) = account.access_token_ciphertext {
      let password = self
        .decryptor
        .decrypt(enc_pw)
        .map_err(|e| format!("password decrypt: {e}"))?;
      return Ok(CalDavCredential::Basic {
        username: account.remote_account_id.clone(),
        password,
      });
    }
    if let Some(ref enc_token) = account.refresh_token_ciphertext {
      let token = self
        .decryptor
        .decrypt(enc_token)
        .map_err(|e| format!("token decrypt: {e}"))?;
      return Ok(CalDavCredential::Bearer(token));
    }
    Err("no credentials configured for CalDAV account".to_string())
  }
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::calendar::test_support::NullCalendarRepository;
  use crate::redis::InMemoryRedisAdapter;

  fn test_lock_redis() -> Arc<dyn RedisPort> {
    Arc::new(InMemoryRedisAdapter::new("caldav-sync-test"))
  }

  #[test]
  fn plaintext_decryptor_is_identity() {
    let dec = PlaintextCredentialDecryptor;
    assert_eq!(dec.decrypt("hunter2").unwrap(), "hunter2");
  }

  #[test]
  fn build_credential_basic_auth() {
    // A CalendarAccount with access_token_ciphertext should build Basic credentials.
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = CalDavSyncService::new(repo, dec, test_lock_redis(), 7, 90, None);

    let account = make_account_with_password("alice", "s3cret");
    let cred = svc.build_credential(&account).unwrap();
    match cred {
      CalDavCredential::Basic { username, password } => {
        assert_eq!(username, "alice");
        assert_eq!(password, "s3cret");
      }
      _ => panic!("expected Basic credential"),
    }
  }

  #[test]
  fn build_credential_bearer_fallback() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = CalDavSyncService::new(repo, dec, test_lock_redis(), 7, 90, None);

    let mut account = make_account_with_password("bob", "ignored");
    account.access_token_ciphertext = None;
    account.refresh_token_ciphertext = Some("token-xyz".to_string());
    let cred = svc.build_credential(&account).unwrap();
    match cred {
      CalDavCredential::Bearer(tok) => assert_eq!(tok, "token-xyz"),
      _ => panic!("expected Bearer credential"),
    }
  }

  #[test]
  fn build_credential_no_creds_returns_err() {
    let dec = Arc::new(PlaintextCredentialDecryptor) as Arc<dyn CredentialDecryptor>;
    let repo = Arc::new(NullCalendarRepository) as Arc<dyn CalendarRepository>;
    let svc = CalDavSyncService::new(repo, dec, test_lock_redis(), 7, 90, None);

    let mut account = make_account_with_password("carol", "pw");
    account.access_token_ciphertext = None;
    account.refresh_token_ciphertext = None;
    assert!(svc.build_credential(&account).is_err());
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  fn make_account_with_password(username: &str, password: &str) -> CalendarAccount {
    let now = Utc::now();
    CalendarAccount {
      id: Uuid::new_v4(),
      user_id: Uuid::new_v4(),
      provider: "caldav".to_string(),
      remote_account_id: username.to_string(),
      access_token_ciphertext: Some(password.to_string()),
      refresh_token_ciphertext: None,
      expires_at: None,
      config: serde_json::json!({"caldavUrl": "https://caldav.example.com/dav/"}),
      created_at: now,
      updated_at: now,
    }
  }
}
