// SPDX-License-Identifier: AGPL-3.0-or-later
//! [`RemoteCalendarWritePort`] implementation for CalDAV and Google Calendar.
//!
//! `MultiProviderCalendarWrite` dispatches create / update / delete
//! operations to the appropriate backend based on the `provider` field of the
//! calendar account stored in the database.
//!
//! Provider routing:
//! - `"caldav"` / `"nextcloud"` / `"icloud"` → [`CalDavClient`]
//! - `"google"` → [`GoogleCalendarClient`]
//!
//! The implementation reads credentials from `CalendarAccount` records via
//! the [`CalendarRepository`].  Credential decryption is delegated to a
//! [`CredentialDecryptor`] supplied at construction time.

use std::sync::Arc;

use async_trait::async_trait;
use tracing::{debug, instrument};
use uuid::Uuid;

use myoxus_application::ports::{
  PortError, PortResult, RemoteCalendarWritePort, RemoteCreateResult, RemoteEventInput, RemoteUpdateResult,
};
use myoxus_domain::repositories::CalendarRepository;

use crate::caldav::sync::CredentialDecryptor;
use crate::caldav::{CalDavClient, CalDavCredential, CalDavError, calendar_event_to_vcalendar};
use crate::google_calendar::{GoogleCalendarClient, GoogleCalendarError, GoogleDateTime, GoogleEventBody};

// ─── Helper: map errors to PortError ─────────────────────────────────────────

fn caldav_to_port(e: CalDavError) -> PortError {
  match e {
    CalDavError::EtagConflict => PortError::Conflict("CalDAV ETag conflict".into()),
    CalDavError::Auth(m) => PortError::InvalidInput(format!("CalDAV auth: {m}")),
    CalDavError::Network(m) | CalDavError::Http(_, m) | CalDavError::Protocol(m) => PortError::Transport(m),
  }
}

fn google_to_port(e: GoogleCalendarError) -> PortError {
  match e {
    GoogleCalendarError::EtagConflict => PortError::Conflict("Google ETag conflict".into()),
    GoogleCalendarError::Auth(m) => PortError::InvalidInput(format!("Google auth: {m}")),
    GoogleCalendarError::Network(m) | GoogleCalendarError::Http(_, m) | GoogleCalendarError::Parse(m) => {
      PortError::Transport(m)
    }
    GoogleCalendarError::SyncTokenExpired => PortError::Transport("Google sync token expired".into()),
  }
}

// ─── CalDAV write helper ──────────────────────────────────────────────────────

/// Serialize a minimal `CalendarEvent`-like struct to VCALENDAR for CalDAV PUT.
fn build_vcal(input: &RemoteEventInput) -> String {
  use myoxus_domain::entities::CalendarEvent;

  let event = CalendarEvent {
    id: Uuid::nil(),
    origin: myoxus_domain::entities::CalendarEventOrigin::External,
    account_id: Some(input.account_id),
    workspace_id: None,
    remote_event_id: Some(input.uid.clone()),
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    title: input.title.clone(),
    description: input.description.clone(),
    description_delta: None,
    location: input.location.clone(),
    source_doc_id: None,
    all_day: false,
    all_members: false,
    tag_id: None,
    recurrence_parent_id: None,
    participants: vec![],
    reminders: vec![],
    payload: input.extra_payload.clone(),
    updated_at: chrono::Utc::now(),
    etag: None,
    remote_href: None,
  };
  calendar_event_to_vcalendar(&event)
}

// ─── Google Calendar write helper ─────────────────────────────────────────────

fn build_google_body(input: &RemoteEventInput) -> GoogleEventBody {
  GoogleEventBody {
    summary: input.title.clone(),
    description: input.description.clone(),
    location: input.location.clone(),
    start: GoogleDateTime {
      date_time: Some(input.starts_at.to_rfc3339()),
      date: None,
      time_zone: None,
    },
    end: GoogleDateTime {
      date_time: Some(input.ends_at.to_rfc3339()),
      date: None,
      time_zone: None,
    },
    attendees: vec![],
    recurrence: vec![],
    reminders: None,
    status: None,
    transparency: None,
  }
}

// ─── Trait implementation (dispatch layer) ────────────────────────────────────

/// Dispatching write port that looks up the provider from the DB per call.
///
/// Because we only have `list_user_calendar_accounts` (not
/// `get_calendar_account_by_id`), the actual implementation is in the `api`
/// crate's `MultiProviderCalendarWrite` adapter which has access to a richer
/// repo interface.  This module provides the shared helpers; the `api` crate
/// wires the concrete implementation.
pub use self::api_adapter::ApiMultiProviderCalendarWrite;

pub mod api_adapter {
  //! Thin adapter that can be used from the `api` crate to implement
  //! `RemoteCalendarWritePort` with access to the full infrastructure.
  use super::*;

  /// A concrete `RemoteCalendarWritePort` implementation suitable for use from
  /// the `api` crate.  It looks up accounts via `list_user_calendar_accounts`
  /// using the `account_id` stored in `RemoteEventInput`.
  pub struct ApiMultiProviderCalendarWrite {
    repo: Arc<dyn CalendarRepository>,
    decryptor: Arc<dyn CredentialDecryptor>,
    additional_ca: Option<crate::tls::ValidatedCaBundle>,
  }

  impl ApiMultiProviderCalendarWrite {
    /// Create a new adapter.
    pub fn new(
      repo: Arc<dyn CalendarRepository>,
      decryptor: Arc<dyn CredentialDecryptor>,
      additional_ca: Option<crate::tls::ValidatedCaBundle>,
    ) -> Self {
      Self {
        repo,
        decryptor,
        additional_ca,
      }
    }

    async fn find_account(&self, account_id: Uuid) -> PortResult<myoxus_domain::entities::CalendarAccount> {
      // O(1) lookup via primary key — avoids fetching all accounts.
      self
        .repo
        .get_calendar_account_by_id(account_id)
        .await
        .map_err(|e| PortError::Transport(e.to_string()))?
        .ok_or_else(|| PortError::NotFound(format!("calendar account {account_id} not found")))
    }
  }

  #[async_trait]
  impl RemoteCalendarWritePort for ApiMultiProviderCalendarWrite {
    #[instrument(skip(self, input))]
    async fn create_event(&self, input: &RemoteEventInput) -> PortResult<RemoteCreateResult> {
      let account = self.find_account(input.account_id).await?;
      let provider = account.provider.as_str();

      match provider {
        "caldav" | "nextcloud" | "icloud" => {
          let cred = build_caldav_cred_from_account(&account, &*self.decryptor)?;
          let base_url = caldav_url(&account)?;
          let client = CalDavClient::new(base_url, cred.clone(), self.additional_ca.as_ref())
            .map_err(|e| PortError::Transport(e.to_string()))?;
          let ical = build_vcal(input);
          let calendar_url = &input.calendar_id;
          let (href, etag) = client
            .create_event(calendar_url, &input.uid, &ical, &cred)
            .await
            .map_err(caldav_to_port)?;
          debug!(account_id = %input.account_id, %href, "caldav create_event succeeded");
          Ok(RemoteCreateResult {
            remote_href: href,
            etag,
            remote_event_id: Some(input.uid.clone()),
          })
        }
        "google" => {
          let token = build_google_token_from_account(&account, &*self.decryptor)?;
          let client = GoogleCalendarClient::new(token, self.additional_ca.as_ref()).map_err(google_to_port)?;
          let body = build_google_body(input);
          let calendar_id = if input.calendar_id.is_empty() {
            "primary"
          } else {
            &input.calendar_id
          };
          let event = client.create_event(calendar_id, &body).await.map_err(google_to_port)?;
          let remote_href = format!("{}/{}", calendar_id, event.id);
          let etag = event.etag.clone();
          debug!(account_id = %input.account_id, event_id = %event.id, "google create_event succeeded");
          Ok(RemoteCreateResult {
            remote_href,
            etag,
            remote_event_id: Some(event.id),
          })
        }
        other => Err(PortError::InvalidInput(format!(
          "unsupported calendar provider: {other}"
        ))),
      }
    }

    #[instrument(skip(self, input))]
    async fn update_event(
      &self,
      remote_href: &str,
      etag: &str,
      input: &RemoteEventInput,
    ) -> PortResult<RemoteUpdateResult> {
      let account = self.find_account(input.account_id).await?;
      let provider = account.provider.as_str();

      match provider {
        "caldav" | "nextcloud" | "icloud" => {
          let cred = build_caldav_cred_from_account(&account, &*self.decryptor)?;
          let base_url = caldav_url(&account)?;
          let client = CalDavClient::new(base_url, cred.clone(), self.additional_ca.as_ref())
            .map_err(|e| PortError::Transport(e.to_string()))?;
          let ical = build_vcal(input);
          let new_etag = client
            .update_event(remote_href, &ical, etag, &cred)
            .await
            .map_err(caldav_to_port)?;
          debug!(account_id = %input.account_id, %remote_href, "caldav update_event succeeded");
          Ok(RemoteUpdateResult { etag: new_etag })
        }
        "google" => {
          let token = build_google_token_from_account(&account, &*self.decryptor)?;
          let client = GoogleCalendarClient::new(token, self.additional_ca.as_ref()).map_err(google_to_port)?;
          let body = build_google_body(input);
          // remote_href for Google is "{calendar_id}/{event_id}".
          let (calendar_id, event_id) = split_google_href(remote_href);
          let event = client
            .update_event(calendar_id, event_id, &body, etag)
            .await
            .map_err(google_to_port)?;
          let new_etag = event.etag.clone();
          debug!(account_id = %input.account_id, %remote_href, "google update_event succeeded");
          Ok(RemoteUpdateResult { etag: new_etag })
        }
        other => Err(PortError::InvalidInput(format!(
          "unsupported calendar provider: {other}"
        ))),
      }
    }

    #[instrument(skip(self, input))]
    async fn delete_event(&self, remote_href: &str, etag: &str, input: &RemoteEventInput) -> PortResult<()> {
      let account = self.find_account(input.account_id).await?;
      let provider = account.provider.as_str();

      match provider {
        "caldav" | "nextcloud" | "icloud" => {
          let cred = build_caldav_cred_from_account(&account, &*self.decryptor)?;
          let base_url = caldav_url(&account)?;
          let client = CalDavClient::new(base_url, cred.clone(), self.additional_ca.as_ref())
            .map_err(|e| PortError::Transport(e.to_string()))?;
          client
            .delete_event(remote_href, etag, &cred)
            .await
            .map_err(caldav_to_port)?;
          debug!(account_id = %input.account_id, %remote_href, "caldav delete_event succeeded");
          Ok(())
        }
        "google" => {
          let token = build_google_token_from_account(&account, &*self.decryptor)?;
          let client = GoogleCalendarClient::new(token, self.additional_ca.as_ref()).map_err(google_to_port)?;
          let (calendar_id, event_id) = split_google_href(remote_href);
          client
            .delete_event(calendar_id, event_id, etag, crate::google_calendar::SendUpdates::None)
            .await
            .map_err(google_to_port)?;
          debug!(account_id = %input.account_id, %remote_href, "google delete_event succeeded");
          Ok(())
        }
        other => Err(PortError::InvalidInput(format!(
          "unsupported calendar provider: {other}"
        ))),
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  fn build_caldav_cred_from_account(
    account: &myoxus_domain::entities::CalendarAccount,
    decryptor: &dyn CredentialDecryptor,
  ) -> PortResult<CalDavCredential> {
    if let Some(ref enc) = account.access_token_ciphertext {
      let pw = decryptor
        .decrypt(enc)
        .map_err(|e| PortError::InvalidInput(format!("credential decrypt: {e}")))?;
      return Ok(CalDavCredential::Basic {
        username: account.remote_account_id.clone(),
        password: pw,
      });
    }
    if let Some(ref enc) = account.refresh_token_ciphertext {
      let token = decryptor
        .decrypt(enc)
        .map_err(|e| PortError::InvalidInput(format!("credential decrypt: {e}")))?;
      return Ok(CalDavCredential::Bearer(token));
    }
    Err(PortError::InvalidInput(
      "no credentials configured for CalDAV account".into(),
    ))
  }

  fn build_google_token_from_account(
    account: &myoxus_domain::entities::CalendarAccount,
    decryptor: &dyn CredentialDecryptor,
  ) -> PortResult<String> {
    account
      .access_token_ciphertext
      .as_deref()
      .ok_or_else(|| PortError::InvalidInput("no access token for Google account".into()))
      .and_then(|enc| {
        decryptor
          .decrypt(enc)
          .map_err(|e| PortError::InvalidInput(format!("token decrypt: {e}")))
      })
  }

  fn caldav_url(account: &myoxus_domain::entities::CalendarAccount) -> PortResult<String> {
    account
      .config
      .get("caldavUrl")
      .and_then(|v| v.as_str())
      .map(str::to_string)
      .ok_or_else(|| PortError::InvalidInput("missing caldavUrl in account config".into()))
  }

  /// Split a Google remote_href `"{calendar_id}/{event_id}"` into parts.
  ///
  /// Falls back to `("primary", remote_href)` if no `/` is found.
  fn split_google_href(remote_href: &str) -> (&str, &str) {
    remote_href
      .find('/')
      .map(|i| (&remote_href[..i], &remote_href[i + 1..]))
      .unwrap_or(("primary", remote_href))
  }
}
