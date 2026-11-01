// SPDX-License-Identifier: AGPL-3.0-or-later
//! CalDAV HTTP client — raw PROPFIND / REPORT over reqwest.
//!
//! # Design
//!
//! Rather than depending on a dedicated caldav crate (none available under a
//! compatible open-source licence at sufficient maturity), this module uses
//! `reqwest` for HTTP and `quick-xml` for XML parsing.
//!
//! Three public entry points are provided:
//!
//! * [`CalDavClient::discover_calendars`] — issues a PROPFIND on the
//!   calendar-home-set URL and returns a list of [`CalDavCalendar`] records.
//! * [`CalDavClient::fetch_events`] — issues a VCALENDAR REPORT with a
//!   time-range filter and returns raw iCalendar strings.
//! * [`parse_ical_events`] — pure parser: turns a raw VCALENDAR string into
//!   a `Vec<ParsedVEvent>`.
//!
//! # V1 scope
//!
//! * Read-only (pull). No push back to the server.
//! * Server-Wins conflict resolution: remote data always overwrites local.
//! * Basic-Auth and Bearer-Token support only (no OAuth refresh in this layer).

pub mod ical_serializer;
pub use ical_serializer::{calendar_event_to_vcalendar, events_to_vcalendar};

pub mod rrule;

pub mod sync;
pub use sync::{CalDavSyncResult, CalDavSyncService, CredentialDecryptor, PlaintextCredentialDecryptor};

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{
  Client,
  header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
};
use tracing::{debug, instrument, trace, warn};

// ─── Public types ─────────────────────────────────────────────────────────────

/// Credentials for authenticating against a CalDAV server.
#[derive(Debug, Clone)]
pub enum CalDavCredential {
  /// HTTP Basic-Auth: username + password or app-password.
  Basic { username: String, password: String },
  /// Bearer token (e.g. from an OAuth flow managed externally).
  Bearer(String),
}

/// A calendar collection discovered via PROPFIND.
#[derive(Debug, Clone)]
pub struct CalDavCalendar {
  /// The href of the calendar collection (relative or absolute).
  pub href: String,
  /// `calendar-description` property if present.
  pub display_name: Option<String>,
  /// The `ctag` / `getctag` property (used for cheap sync-token comparison).
  pub ctag: Option<String>,
}

/// A single parsed VEVENT from an iCalendar VCALENDAR payload.
#[derive(Debug, Clone)]
pub struct ParsedVEvent {
  /// Globally unique identifier (`UID` property).
  pub uid: String,
  /// Event start time, normalised to UTC.
  pub starts_at: DateTime<Utc>,
  /// Event end time, normalised to UTC.  When only `DURATION` is present it
  /// is computed from `DTSTART`.
  pub ends_at: DateTime<Utc>,
  /// `SUMMARY` property (the event title).
  pub summary: Option<String>,
  /// `DESCRIPTION` property.
  pub description: Option<String>,
  /// `LOCATION` property.
  pub location: Option<String>,
  /// `STATUS` property (e.g. `CONFIRMED`, `TENTATIVE`, `CANCELLED`).
  pub status: Option<String>,
  /// `RRULE` raw string — kept opaque for V1 (callers store it in `payload`).
  pub rrule: Option<String>,
  /// `RECURRENCE-ID` value when this is an exception instance.
  pub recurrence_id: Option<String>,
  /// `TZID` of the DTSTART value (for display purposes; dates are in UTC).
  pub original_timezone: Option<String>,
  /// `true` if DTSTART was a DATE (not DATE-TIME) value.
  pub all_day: bool,
  /// Organiser email extracted from `ORGANIZER:mailto:…`.
  pub organizer_email: Option<String>,
  /// Attendee emails extracted from `ATTENDEE` properties.
  pub attendees: Vec<CalDavAttendee>,
}

/// An attendee line extracted from a VEVENT.
#[derive(Debug, Clone)]
pub struct CalDavAttendee {
  pub email: String,
  pub display_name: Option<String>,
  pub rsvp_status: String,
  pub is_organizer: bool,
}

// ─── Client ───────────────────────────────────────────────────────────────────

/// Thin CalDAV HTTP client.
///
/// Constructed once per sync run and reused across discover + fetch calls.
pub struct CalDavClient {
  http: Client,
  base_url: String,
  credential: CalDavCredential,
}

impl CalDavClient {
  /// Construct a new client.
  ///
  /// `base_url` should point to the calendar-home-set root URL
  /// (e.g. `https://caldav.example.com/dav/user/calendars/`).
  pub fn new(
    base_url: String,
    credential: CalDavCredential,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, CalDavError> {
    let http = crate::tls::build_http_client(
      Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Myoxus-CalDAV/1.0"),
      additional_ca,
    )
    .map_err(|e| CalDavError::Protocol(format!("failed to build HTTP client: {e}")))?;
    Ok(Self {
      http,
      base_url,
      credential,
    })
  }

  /// Build the `Authorization` header for this credential.
  fn auth_header(&self) -> String {
    match &self.credential {
      CalDavCredential::Basic { username, password } => {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let encoded = STANDARD.encode(format!("{username}:{password}"));
        format!("Basic {encoded}")
      }
      CalDavCredential::Bearer(token) => format!("Bearer {token}"),
    }
  }

  /// Perform a single PROPFIND HTTP request (no retry).
  async fn propfind_once(&self, url: &str, depth: &str, body: &str) -> Result<String, CalDavError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml; charset=utf-8"));
    headers.insert(
      "Depth",
      HeaderValue::from_str(depth).map_err(|e| CalDavError::Protocol(e.to_string()))?,
    );
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&self.auth_header()).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );

    trace!(%url, depth, "issuing PROPFIND");
    let response = self
      .http
      .request(
        reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is valid"),
        url,
      )
      .headers(headers)
      .body(body.to_string())
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    if !status.is_success() && status.as_u16() != 207 {
      return Err(CalDavError::Http(
        status.as_u16(),
        format!("PROPFIND {url} returned {status}"),
      ));
    }

    let text = response.text().await.map_err(|e| CalDavError::Network(e.to_string()))?;
    debug!(%url, response_bytes = text.len(), "PROPFIND response received");
    Ok(text)
  }

  /// Perform a PROPFIND request with retry for transient HTTP errors.
  #[instrument(skip(self, body), fields(url = %url))]
  async fn propfind(&self, url: &str, depth: &str, body: &str) -> Result<String, CalDavError> {
    let url_owned = url.to_string();
    let depth_owned = depth.to_string();
    let body_owned = body.to_string();
    crate::http_retry::retry_on_transient("caldav::propfind", 3, || {
      self.propfind_once(&url_owned, &depth_owned, &body_owned)
    })
    .await
  }

  /// Perform a single REPORT HTTP request (no retry).
  async fn report_once(&self, url: &str, body: &str) -> Result<String, CalDavError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml; charset=utf-8"));
    headers.insert("Depth", HeaderValue::from_static("1"));
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&self.auth_header()).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );

    trace!(%url, "issuing REPORT");
    let response = self
      .http
      .request(reqwest::Method::from_bytes(b"REPORT").expect("REPORT is valid"), url)
      .headers(headers)
      .body(body.to_string())
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    if !status.is_success() && status.as_u16() != 207 {
      return Err(CalDavError::Http(
        status.as_u16(),
        format!("REPORT {url} returned {status}"),
      ));
    }

    let text = response.text().await.map_err(|e| CalDavError::Network(e.to_string()))?;
    debug!(%url, response_bytes = text.len(), "REPORT response received");
    Ok(text)
  }

  /// Perform a REPORT request with retry for transient HTTP errors.
  #[instrument(skip(self, body), fields(url = %url))]
  async fn report(&self, url: &str, body: &str) -> Result<String, CalDavError> {
    let url_owned = url.to_string();
    let body_owned = body.to_string();
    crate::http_retry::retry_on_transient("caldav::report", 3, || self.report_once(&url_owned, &body_owned)).await
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /// Discover calendar collections under `base_url` via a Depth:1 PROPFIND.
  ///
  /// Returns a list of [`CalDavCalendar`] entries.  Unknown collection types
  /// are silently skipped so that principal and inbox collections do not
  /// appear in the result.
  #[instrument(skip(self))]
  pub async fn discover_calendars(&self) -> Result<Vec<CalDavCalendar>, CalDavError> {
    let propfind_body = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <CS:getctag/>
    <C:calendar-description/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>"#;

    let xml = self.propfind(&self.base_url.clone(), "1", propfind_body).await?;
    parse_propfind_calendars(&xml)
  }

  /// Fetch VEVENT resources from `calendar_url` within `[from, to]`.
  ///
  /// Issues a `calendar-query` REPORT with a `<time-range>` filter.
  /// Returns raw iCalendar strings — one per response `<calendar-data>` element.
  /// Callers should parse them with [`parse_ical_events`].
  #[instrument(skip(self), fields(calendar_url = %calendar_url, %from, %to))]
  pub async fn fetch_events(
    &self,
    calendar_url: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<Vec<String>, CalDavError> {
    let from_str = from.format("%Y%m%dT%H%M%SZ").to_string();
    let to_str = to.format("%Y%m%dT%H%M%SZ").to_string();

    let report_body = format!(
      r#"<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="{from_str}" end="{to_str}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>"#
    );

    let xml = self.report(calendar_url, &report_body).await?;
    parse_report_calendar_data(&xml)
  }

  /// Fetch VEVENT resources by a list of explicit `href` paths using a
  /// `calendar-multiget` REPORT.
  ///
  /// For large calendars (>100 events) the hrefs are chunked into batches of
  /// `MULTIGET_CHUNK_SIZE` to avoid hitting server request-size limits.
  /// Results from all chunks are merged before returning.
  ///
  /// Returns raw iCalendar strings — one per `<calendar-data>` element across
  /// all chunks.  Callers should parse them with [`parse_ical_events`].
  #[instrument(skip(self, hrefs), fields(calendar_url = %calendar_url, href_count = hrefs.len()))]
  pub async fn fetch_events_by_hrefs(&self, calendar_url: &str, hrefs: &[String]) -> Result<Vec<String>, CalDavError> {
    if hrefs.is_empty() {
      return Ok(vec![]);
    }

    let mut all_ical: Vec<String> = Vec::with_capacity(hrefs.len());
    let mut chunk_num = 0usize;

    for chunk in hrefs.chunks(MULTIGET_CHUNK_SIZE) {
      chunk_num += 1;
      trace!(
        %calendar_url,
        chunk = chunk_num,
        chunk_size = chunk.len(),
        "caldav: issuing calendar-multiget for chunk"
      );

      let href_elements: String = chunk.iter().map(|h| format!("  <D:href>{h}</D:href>\n")).collect();

      let report_body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
{href_elements}</C:calendar-multiget>"#
      );

      let xml = self.report(calendar_url, &report_body).await?;
      let chunk_ical = parse_report_calendar_data(&xml)?;

      debug!(
        %calendar_url,
        chunk = chunk_num,
        events_in_chunk = chunk_ical.len(),
        "caldav: calendar-multiget chunk complete"
      );

      all_ical.extend(chunk_ical);
    }

    debug!(
      %calendar_url,
      total_chunks = chunk_num,
      total_events = all_ical.len(),
      "caldav: all multiget chunks fetched"
    );

    Ok(all_ical)
  }

  /// Like `fetch_events` but returns structured [`ReportItem`]s that include
  /// the per-resource ETag alongside the iCalendar data.  Used by the sync
  /// service (F-01) to persist ETags for optimistic locking.
  #[instrument(skip(self), fields(calendar_url = %calendar_url, %from, %to))]
  pub async fn fetch_events_with_etags(
    &self,
    calendar_url: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
  ) -> Result<Vec<ReportItem>, CalDavError> {
    let from_str = from.format("%Y%m%dT%H%M%SZ").to_string();
    let to_str = to.format("%Y%m%dT%H%M%SZ").to_string();
    let report_body = format!(
      r#"<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="{from_str}" end="{to_str}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>"#
    );
    let xml = self.report(calendar_url, &report_body).await?;
    parse_report_items(&xml)
  }

  // ─── Write-back methods (E-01 / E-02 / E-03) ─────────────────────────────

  /// Create a new VEVENT resource on the remote CalDAV server (RFC 4791 §5.3.2).
  ///
  /// Issues a `PUT {calendar_url}/{uid}.ics` with `If-None-Match: *` to
  /// prevent accidentally overwriting an existing resource.
  ///
  /// # Arguments
  /// * `calendar_url` — calendar collection URL (e.g. `…/calendars/default/`)
  /// * `uid` — globally-unique event identifier (used as the resource name)
  /// * `ical_data` — full VCALENDAR text (CRLF, RFC 5545)
  /// * `cred` — credentials to authenticate the request
  ///
  /// # Returns
  /// `(href, etag)` — the canonical href of the new resource and the ETag
  /// returned by the server (if any).
  #[instrument(skip(self, ical_data, cred), fields(%calendar_url, %uid))]
  pub async fn create_event(
    &self,
    calendar_url: &str,
    uid: &str,
    ical_data: &str,
    cred: &CalDavCredential,
  ) -> Result<(String, Option<String>), CalDavError> {
    // Sanitise calendar_url: ensure it ends with '/'
    let base = if calendar_url.ends_with('/') {
      calendar_url.to_string()
    } else {
      format!("{calendar_url}/")
    };
    let href = format!("{base}{uid}.ics");

    let auth = Self::auth_header_for(cred);
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/calendar; charset=utf-8"));
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&auth).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );
    // If-None-Match: * — refuse to overwrite existing resource
    headers.insert("If-None-Match", HeaderValue::from_static("*"));

    trace!(%href, "issuing PUT (create)");

    let response = self
      .http
      .put(&href)
      .headers(headers)
      .body(ical_data.to_string())
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    if status.as_u16() == 412 {
      return Err(CalDavError::EtagConflict);
    }
    if !status.is_success() {
      return Err(CalDavError::Http(
        status.as_u16(),
        format!("PUT (create) {href} returned {status}"),
      ));
    }

    // Extract the ETag (servers return it with quotes; strip them for storage).
    let etag = response
      .headers()
      .get("ETag")
      .and_then(|v| v.to_str().ok())
      .map(strip_etag_quotes);

    debug!(%href, ?etag, "event created on remote CalDAV server");
    Ok((href, etag))
  }

  /// Update an existing VEVENT resource on the remote CalDAV server (RFC 4791).
  ///
  /// Issues a `PUT {event_href}` with `If-Match: "{etag}"` for optimistic
  /// locking.  Returns `Err(CalDavError::EtagConflict)` on a `412` response
  /// so callers can detect concurrent modifications.
  ///
  /// # Arguments
  /// * `event_href` — full URL/href of the existing `.ics` resource
  /// * `ical_data` — updated VCALENDAR text
  /// * `etag` — ETag obtained when the resource was last fetched
  /// * `cred` — credentials
  ///
  /// # Returns
  /// The new ETag returned by the server, or `None` if the server did not
  /// include one (which is allowed by RFC 4918).
  #[instrument(skip(self, ical_data, cred), fields(%event_href))]
  pub async fn update_event(
    &self,
    event_href: &str,
    ical_data: &str,
    etag: &str,
    cred: &CalDavCredential,
  ) -> Result<Option<String>, CalDavError> {
    let auth = Self::auth_header_for(cred);
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/calendar; charset=utf-8"));
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&auth).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );
    // If-Match with quoted ETag (add quotes if not already present)
    let quoted = quote_etag(etag);
    headers.insert(
      "If-Match",
      HeaderValue::from_str(&quoted).map_err(|e| CalDavError::Protocol(e.to_string()))?,
    );

    trace!(%event_href, "issuing PUT (update)");

    let response = self
      .http
      .put(event_href)
      .headers(headers)
      .body(ical_data.to_string())
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    if status.as_u16() == 412 {
      return Err(CalDavError::EtagConflict);
    }
    if !status.is_success() {
      return Err(CalDavError::Http(
        status.as_u16(),
        format!("PUT (update) {event_href} returned {status}"),
      ));
    }

    let new_etag = response
      .headers()
      .get("ETag")
      .and_then(|v| v.to_str().ok())
      .map(strip_etag_quotes);

    debug!(%event_href, ?new_etag, "event updated on remote CalDAV server");
    Ok(new_etag)
  }

  /// Delete a VEVENT resource on the remote CalDAV server (RFC 4918 §9.6).
  ///
  /// Issues `DELETE {event_href}` with `If-Match: "{etag}"`.
  ///
  /// This operation is **idempotent**: a `404 Not Found` response is treated
  /// as success because the desired postcondition (resource absent) is already
  /// satisfied.
  ///
  /// # Arguments
  /// * `event_href` — full URL/href of the `.ics` resource to delete
  /// * `etag` — ETag for optimistic locking
  /// * `cred` — credentials
  #[instrument(skip(self, cred), fields(%event_href))]
  pub async fn delete_event(&self, event_href: &str, etag: &str, cred: &CalDavCredential) -> Result<(), CalDavError> {
    let auth = Self::auth_header_for(cred);
    let mut headers = HeaderMap::new();
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&auth).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );
    let quoted = quote_etag(etag);
    headers.insert(
      "If-Match",
      HeaderValue::from_str(&quoted).map_err(|e| CalDavError::Protocol(e.to_string()))?,
    );

    trace!(%event_href, "issuing DELETE");

    let response = self
      .http
      .delete(event_href)
      .headers(headers)
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    match status.as_u16() {
      // Success codes: 200 OK, 204 No Content
      200 | 204 => {
        debug!(%event_href, "event deleted from remote CalDAV server");
        Ok(())
      }
      // 404 Not Found: already deleted — idempotent
      404 => {
        debug!(%event_href, "event not found on remote CalDAV server (already deleted)");
        Ok(())
      }
      412 => Err(CalDavError::EtagConflict),
      other => Err(CalDavError::Http(
        other,
        format!("DELETE {event_href} returned {status}"),
      )),
    }
  }

  // ─── RFC 6638 scheduling capabilities (P90-CAL-B-04) ─────────────────────

  /// Detect CalDAV scheduling capabilities (RFC 6638) on the server.
  ///
  /// Issues a `PROPFIND Depth:0` on `principal_url` and looks for:
  /// - `DAV:schedule-inbox-URL`
  /// - `DAV:schedule-outbox-URL`
  ///
  /// Returns a [`SchedulingCapabilities`] struct. The `rfc6638` flag is `true`
  /// when at least one of the inbox or outbox properties is present.
  ///
  /// The result should be stored in `calendar_accounts.config` JSONB under the
  /// key `"scheduling"` when linking a CalDAV account.
  #[instrument(skip(self, cred), fields(%principal_url))]
  pub async fn detect_scheduling_capabilities(
    &self,
    principal_url: &str,
    cred: &CalDavCredential,
  ) -> Result<SchedulingCapabilities, CalDavError> {
    let propfind_body = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:schedule-inbox-URL/>
    <C:schedule-outbox-URL/>
  </D:prop>
</D:propfind>"#;

    // Build request with the provided credential (not self.credential).
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/xml; charset=utf-8"));
    headers.insert("Depth", HeaderValue::from_static("0"));
    headers.insert(
      AUTHORIZATION,
      HeaderValue::from_str(&Self::auth_header_for(cred)).map_err(|e| CalDavError::Auth(e.to_string()))?,
    );

    trace!(%principal_url, "issuing PROPFIND for scheduling capabilities");

    let response = self
      .http
      .request(
        reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is valid"),
        principal_url,
      )
      .headers(headers)
      .body(propfind_body.to_string())
      .send()
      .await
      .map_err(|e| CalDavError::Network(e.to_string()))?;

    let status = response.status();
    // 207 Multi-Status = success; 200 also accepted.
    if !status.is_success() && status.as_u16() != 207 {
      debug!(%principal_url, status = status.as_u16(),
        "caldav: scheduling capabilities PROPFIND returned non-success, assuming no RFC 6638");
      return Ok(SchedulingCapabilities {
        rfc6638: false,
        schedule_inbox: None,
        schedule_outbox: None,
      });
    }

    let xml = response.text().await.map_err(|e| CalDavError::Network(e.to_string()))?;
    debug!(%principal_url, response_bytes = xml.len(), "caldav: scheduling capabilities response received");

    let caps = parse_scheduling_capabilities(&xml);
    debug!(
      %principal_url,
      rfc6638 = caps.rfc6638,
      schedule_inbox = caps.schedule_inbox.as_deref().unwrap_or("none"),
      schedule_outbox = caps.schedule_outbox.as_deref().unwrap_or("none"),
      "caldav: scheduling capabilities detected"
    );

    Ok(caps)
  }

  /// Build an Authorization header value from a [`CalDavCredential`].
  ///
  /// This is a static helper that accepts a credential by reference rather
  /// than using `self.credential`, to allow the write-back methods to accept
  /// an explicit credential parameter (matching the method signatures in the
  /// task spec).
  fn auth_header_for(cred: &CalDavCredential) -> String {
    match cred {
      CalDavCredential::Basic { username, password } => {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let encoded = STANDARD.encode(format!("{username}:{password}"));
        format!("Basic {encoded}")
      }
      CalDavCredential::Bearer(token) => format!("Bearer {token}"),
    }
  }
}

/// Chunk size for `calendar-multiget` REPORT requests.
///
/// Large calendars can have thousands of events.  Fetching all hrefs in a
/// single REPORT request risks hitting CalDAV server request-size limits.
/// 100 hrefs per chunk is a well-established safe default used by major
/// CalDAV clients (Thunderbird, macOS Calendar, Evolution).
const MULTIGET_CHUNK_SIZE: usize = 100;

// ─── RFC 6638 scheduling capabilities (P90-CAL-B-04) ─────────────────────────

/// CalDAV RFC 6638 scheduling capabilities detected on a CalDAV principal.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SchedulingCapabilities {
  /// `true` when at least one scheduling URL (inbox or outbox) was found,
  /// indicating the server supports RFC 6638.
  pub rfc6638: bool,
  /// Absolute URL of the scheduling inbox (`schedule-inbox-URL` property).
  pub schedule_inbox: Option<String>,
  /// Absolute URL of the scheduling outbox (`schedule-outbox-URL` property).
  pub schedule_outbox: Option<String>,
}

/// Parse a PROPFIND response for RFC 6638 scheduling properties.
///
/// Looks for `caldav:schedule-inbox-URL` and `caldav:schedule-outbox-URL`
/// in a multi-status response.  Missing or empty values are silently ignored.
pub fn parse_scheduling_capabilities(xml: &str) -> SchedulingCapabilities {
  use quick_xml::Reader;
  use quick_xml::events::Event;

  let mut reader = Reader::from_str(xml);
  reader.config_mut().trim_text(true);

  let mut schedule_inbox: Option<String> = None;
  let mut schedule_outbox: Option<String> = None;
  let mut in_inbox_url = false;
  let mut in_outbox_url = false;
  let mut in_href = false;
  let mut current_text = String::new();

  let mut buf = Vec::new();
  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
        let name_bytes = e.name().as_ref().to_vec();
        let local = local_name(&name_bytes);
        match local {
          "schedule-inbox-URL" => {
            in_inbox_url = true;
            in_outbox_url = false;
          }
          "schedule-outbox-URL" => {
            in_outbox_url = true;
            in_inbox_url = false;
          }
          "href" if in_inbox_url || in_outbox_url => {
            in_href = true;
            current_text.clear();
          }
          _ => {}
        }
      }
      Ok(Event::Text(ref e)) => {
        if in_href && let Ok(t) = e.xml10_content() {
          current_text.push_str(&t);
        }
      }
      Ok(Event::GeneralRef(ref e)) if in_href => {
        if let Some(value) = decode_xml_reference(e) {
          current_text.push_str(&value);
        }
      }
      Ok(Event::End(ref e)) => {
        let name_bytes = e.name().as_ref().to_vec();
        let local = local_name(&name_bytes);
        match local {
          "href" if in_href => {
            let val = current_text.trim().to_string();
            if !val.is_empty() {
              if in_inbox_url {
                schedule_inbox = Some(val);
              } else if in_outbox_url {
                schedule_outbox = Some(val);
              }
            }
            in_href = false;
            current_text.clear();
          }
          "schedule-inbox-URL" => in_inbox_url = false,
          "schedule-outbox-URL" => in_outbox_url = false,
          _ => {}
        }
      }
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
    buf.clear();
  }

  let rfc6638 = schedule_inbox.is_some() || schedule_outbox.is_some();
  SchedulingCapabilities {
    rfc6638,
    schedule_inbox,
    schedule_outbox,
  }
}

// ─── Error type ───────────────────────────────────────────────────────────────

/// Errors returned by the CalDAV client.
#[derive(Debug, thiserror::Error)]
pub enum CalDavError {
  /// Network-level error (connect timeout, DNS failure, etc.).
  #[error("network error: {0}")]
  Network(String),
  /// Authentication failure.
  #[error("authentication error: {0}")]
  Auth(String),
  /// Unexpected HTTP status code.
  #[error("HTTP {0}: {1}")]
  Http(u16, String),
  /// CalDAV protocol or XML parsing error.
  #[error("protocol error: {0}")]
  Protocol(String),
  /// ETag precondition failed (412) — the remote resource was modified
  /// concurrently.  Caller should re-fetch and retry.
  #[error("ETag conflict: remote resource was modified concurrently (412 Precondition Failed)")]
  EtagConflict,
}

// ─── XML parsing helpers ──────────────────────────────────────────────────────

/// Parse a multi-status PROPFIND response into a list of `CalDavCalendar` structs.
///
/// Handles both namespace-qualified (`D:`, `C:`) and unqualified elements.
pub fn parse_propfind_calendars(xml: &str) -> Result<Vec<CalDavCalendar>, CalDavError> {
  use quick_xml::Reader;
  use quick_xml::events::Event;

  let mut reader = Reader::from_str(xml);
  reader.config_mut().trim_text(true);

  let mut calendars: Vec<CalDavCalendar> = Vec::new();

  // State machine per `<response>` block.
  let mut in_response = false;
  let mut in_prop = false;
  let mut is_calendar = false;
  let mut href: Option<String> = None;
  let mut display_name: Option<String> = None;
  let mut ctag: Option<String> = None;
  let mut current_text = String::new();

  let mut buf = Vec::new();
  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) => {
        let name_bytes = e.name().as_ref().to_vec();
        let local = local_name(&name_bytes).to_ascii_lowercase();
        match local.as_str() {
          "response" => {
            in_response = true;
            href = None;
            display_name = None;
            ctag = None;
            is_calendar = false;
          }
          "prop" | "propstat" => {
            in_prop = true;
          }
          "calendar" if in_prop => {
            // <C:calendar/> inside <resourcetype> marks this as a calendar collection.
            is_calendar = true;
          }
          _ => {}
        }
        current_text.clear();
      }
      Ok(Event::Empty(ref e)) => {
        // Self-closing <C:calendar/> element
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        if local == "calendar" && in_prop {
          is_calendar = true;
        }
      }
      Ok(Event::Text(ref e)) => {
        if let Ok(t) = e.xml10_content() {
          current_text.push_str(&t);
        }
      }
      Ok(Event::GeneralRef(ref e)) => {
        if let Some(value) = decode_xml_reference(e) {
          current_text.push_str(&value);
        }
      }
      Ok(Event::End(ref e)) => {
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        match local.as_str() {
          "href" if in_response => {
            href = Some(current_text.trim().to_string());
          }
          "displayname" | "calendar-description" if in_prop && !current_text.is_empty() => {
            display_name = Some(current_text.trim().to_string());
          }
          "getctag" if in_prop && !current_text.is_empty() => {
            ctag = Some(current_text.trim().to_string());
          }
          "response" => {
            if in_response
              && is_calendar
              && let Some(h) = href.take()
            {
              calendars.push(CalDavCalendar {
                href: h,
                display_name: display_name.take(),
                ctag: ctag.take(),
              });
            }
            in_response = false;
            in_prop = false;
            is_calendar = false;
            href = None;
            display_name = None;
            ctag = None;
          }
          "prop" | "propstat" => {
            in_prop = false;
          }
          _ => {}
        }
        current_text.clear();
      }
      Ok(Event::Eof) => break,
      Err(e) => {
        warn!(error = %e, "CalDAV PROPFIND XML parse error (non-fatal, partial results returned)");
        break;
      }
      _ => {}
    }
    buf.clear();
  }

  trace!(calendar_count = calendars.len(), "parsed PROPFIND calendars");
  Ok(calendars)
}

/// Parse a multi-status REPORT response and extract `<calendar-data>` text nodes.
pub fn parse_report_calendar_data(xml: &str) -> Result<Vec<String>, CalDavError> {
  use quick_xml::Reader;
  use quick_xml::events::Event;

  let mut reader = Reader::from_str(xml);
  reader.config_mut().trim_text(true);

  let mut results: Vec<String> = Vec::new();
  let mut in_calendar_data = false;
  let mut buffer = String::new();
  let mut buf = Vec::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) => {
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        if local == "calendar-data" {
          in_calendar_data = true;
          buffer.clear();
        }
      }
      Ok(Event::Text(ref e)) => {
        if in_calendar_data && let Ok(t) = e.xml10_content() {
          buffer.push_str(&t);
        }
      }
      Ok(Event::GeneralRef(ref e)) if in_calendar_data => {
        if let Some(value) = decode_xml_reference(e) {
          buffer.push_str(&value);
        }
      }
      Ok(Event::CData(ref e)) if in_calendar_data => {
        let bytes = e.clone().into_inner();
        if let Ok(s) = std::str::from_utf8(&bytes) {
          buffer.push_str(s);
        }
      }
      Ok(Event::End(ref e)) => {
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        if local == "calendar-data" && in_calendar_data {
          let trimmed = buffer.trim().to_string();
          if !trimmed.is_empty() {
            results.push(trimmed);
          }
          in_calendar_data = false;
          buffer.clear();
        }
      }
      Ok(Event::Eof) => break,
      Err(e) => {
        warn!(error = %e, "CalDAV REPORT XML parse error (non-fatal, partial results returned)");
        break;
      }
      _ => {}
    }
    buf.clear();
  }

  trace!(ical_count = results.len(), "parsed REPORT calendar-data items");
  Ok(results)
}

/// A single item returned by a CalDAV REPORT (calendar-query or calendar-multiget).
#[derive(Debug, Clone)]
pub struct ReportItem {
  /// The `<D:href>` of the `.ics` resource.
  pub href: String,
  /// The `<D:getetag>` value (without quotes), or `None` if absent.
  pub etag: Option<String>,
  /// The raw iCalendar text from `<C:calendar-data>`.
  pub ical: String,
}

/// Parse a multi-status REPORT response, extracting href, getetag, and
/// calendar-data per `<D:response>` element.
///
/// This is the structured counterpart of [`parse_report_calendar_data`]
/// — used when ETag data is needed for optimistic locking.
pub fn parse_report_items(xml: &str) -> Result<Vec<ReportItem>, CalDavError> {
  use quick_xml::Reader;
  use quick_xml::events::Event;

  let mut reader = Reader::from_str(xml);
  reader.config_mut().trim_text(true);

  let mut items: Vec<ReportItem> = Vec::new();

  let mut in_response = false;
  let mut in_prop = false;
  let mut in_calendar_data = false;
  let mut current_href: Option<String> = None;
  let mut current_etag: Option<String> = None;
  let mut cal_data_buf = String::new();
  let mut text_buf = String::new();
  let mut buf = Vec::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(ref e)) => {
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        match local.as_str() {
          "response" => {
            in_response = true;
            current_href = None;
            current_etag = None;
            cal_data_buf.clear();
          }
          "prop" | "propstat" if in_response => {
            in_prop = true;
          }
          "calendar-data" if in_prop => {
            in_calendar_data = true;
            cal_data_buf.clear();
          }
          _ => {}
        }
        text_buf.clear();
      }
      Ok(Event::Text(ref e)) => {
        if let Ok(t) = e.xml10_content() {
          if in_calendar_data {
            cal_data_buf.push_str(&t);
          } else {
            text_buf.push_str(&t);
          }
        }
      }
      Ok(Event::GeneralRef(ref e)) => {
        if let Some(value) = decode_xml_reference(e) {
          if in_calendar_data {
            cal_data_buf.push_str(&value);
          } else {
            text_buf.push_str(&value);
          }
        }
      }
      Ok(Event::CData(ref e)) if in_calendar_data => {
        let bytes = e.clone().into_inner();
        if let Ok(s) = std::str::from_utf8(&bytes) {
          cal_data_buf.push_str(s);
        }
      }
      Ok(Event::End(ref e)) => {
        let local = local_name(e.name().as_ref()).to_ascii_lowercase();
        match local.as_str() {
          "href" if in_response && !in_prop => {
            current_href = Some(text_buf.trim().to_string());
          }
          "getetag" if in_prop && !text_buf.is_empty() => {
            current_etag = Some(strip_etag_quotes(text_buf.trim()));
          }
          "calendar-data" if in_calendar_data => {
            in_calendar_data = false;
          }
          "prop" | "propstat" => {
            in_prop = false;
          }
          "response" => {
            let ical = cal_data_buf.trim().to_string();
            if !ical.is_empty()
              && let Some(href) = current_href.take()
            {
              items.push(ReportItem {
                href,
                etag: current_etag.take(),
                ical,
              });
            }
            in_response = false;
            current_href = None;
            current_etag = None;
            cal_data_buf.clear();
          }
          _ => {}
        }
        text_buf.clear();
      }
      Ok(Event::Eof) => break,
      Err(e) => {
        warn!(error = %e, "CalDAV REPORT XML parse error (non-fatal)");
        break;
      }
      _ => {}
    }
    buf.clear();
  }

  trace!(item_count = items.len(), "parsed REPORT items with ETags");
  Ok(items)
}

// ─── ETag helpers ─────────────────────────────────────────────────────────────

/// Strip surrounding double-quotes from an ETag value.
///
/// CalDAV servers commonly return ETags as `"<opaque-token>"` (with quotes).
/// This function strips the outer quotes so the value can be stored cleanly.
/// A strong ETag without quotes is returned as-is.
fn strip_etag_quotes(etag: &str) -> String {
  let t = etag.trim();
  if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
    t[1..t.len() - 1].to_string()
  } else {
    t.to_string()
  }
}

/// Wrap an ETag value in double-quotes for use in `If-Match` / `If-None-Match`
/// headers.
///
/// If the value is already quoted, it is returned unchanged.
fn quote_etag(etag: &str) -> String {
  let t = etag.trim();
  if t.starts_with('"') && t.ends_with('"') {
    t.to_string()
  } else {
    format!("\"{t}\"")
  }
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

/// Strip XML namespace prefix from an element name, returning just the local part.
fn local_name(name: &[u8]) -> &str {
  let s = std::str::from_utf8(name).unwrap_or("");
  if let Some(pos) = s.find(':') { &s[pos + 1..] } else { s }
}

/// Resolve bounded XML character/predefined references without consulting DTD
/// entity declarations. CalDAV values are untrusted server responses, so
/// recursive or custom entity expansion is intentionally unsupported.
fn decode_xml_reference(reference: &quick_xml::events::BytesRef<'_>) -> Option<String> {
  if let Ok(Some(value)) = reference.resolve_char_ref() {
    return Some(value.to_string());
  }
  let name = reference.decode().ok()?;
  quick_xml::escape::resolve_predefined_entity(&name).map(str::to_owned)
}

// ─── iCalendar parser ─────────────────────────────────────────────────────────

/// Parse a raw VCALENDAR string and return all VEVENT blocks found in it.
///
/// This is a line-folding-aware, pure-text parser. It handles:
/// - RFC 5545 line folding (continuation lines starting with space/tab).
/// - DATE vs DATE-TIME values (both UTC `Z` and `TZID=…` forms).
/// - DURATION-only DTEND computation.
/// - ATTENDEE `CN=…;PARTSTAT=…;RSVP=…:mailto:email` parameters.
/// - ORGANIZER `CN=…:mailto:email` parameters.
///
/// Returns a `Vec<ParsedVEvent>` — caller decides what to do with them.
pub fn parse_ical_events(ical: &str) -> Vec<ParsedVEvent> {
  // Step 1: unfold lines (RFC 5545 §3.1: continuation lines start with space or tab).
  let unfolded = unfold_ical(ical);

  let mut events: Vec<ParsedVEvent> = Vec::new();
  let mut in_vevent = false;

  // Per-VEVENT state
  let mut uid: Option<String> = None;
  let mut dtstart: Option<String> = None;
  let mut dtstart_tzid: Option<String> = None;
  let mut dtstart_is_date = false;
  let mut dtend: Option<String> = None;
  let mut duration_secs: Option<i64> = None;
  let mut summary: Option<String> = None;
  let mut description: Option<String> = None;
  let mut location: Option<String> = None;
  let mut status: Option<String> = None;
  let mut rrule: Option<String> = None;
  let mut recurrence_id: Option<String> = None;
  let mut organizer_email: Option<String> = None;
  let mut attendees: Vec<CalDavAttendee> = Vec::new();

  for raw_line in unfolded.lines() {
    let line = raw_line.trim_end();
    if line.is_empty() {
      continue;
    }

    if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
      in_vevent = true;
      // Reset per-event state
      uid = None;
      dtstart = None;
      dtstart_tzid = None;
      dtstart_is_date = false;
      dtend = None;
      duration_secs = None;
      summary = None;
      description = None;
      location = None;
      status = None;
      rrule = None;
      recurrence_id = None;
      organizer_email = None;
      attendees.clear();
      continue;
    }

    if line.eq_ignore_ascii_case("END:VEVENT") {
      in_vevent = false;

      // Only emit event if we have enough data to be meaningful.
      if let Some(uid_val) = uid.take() {
        match build_event(RawVEventFields {
          uid: uid_val,
          dtstart: dtstart.take(),
          dtstart_tzid: dtstart_tzid.take(),
          dtstart_is_date,
          dtend: dtend.take(),
          duration_secs,
          summary: summary.take(),
          description: description.take(),
          location: location.take(),
          status: status.take(),
          rrule: rrule.take(),
          recurrence_id: recurrence_id.take(),
          organizer_email: organizer_email.take(),
          attendees: std::mem::take(&mut attendees),
        }) {
          Ok(ev) => events.push(ev),
          Err(e) => {
            debug!(error = %e, "skipping unparseable VEVENT");
          }
        }
      }
      continue;
    }

    if !in_vevent {
      continue;
    }

    // Split into property name (with optional params) and value.
    let (prop_with_params, value) = match line.split_once(':') {
      Some(pair) => pair,
      None => continue,
    };

    // Split off parameters: e.g. `DTSTART;TZID=Europe/Berlin`
    let (prop_name, params) = if let Some(sc) = prop_with_params.find(';') {
      (&prop_with_params[..sc], &prop_with_params[sc + 1..])
    } else {
      (prop_with_params, "")
    };

    match prop_name.to_ascii_uppercase().as_str() {
      "UID" => uid = Some(value.to_string()),
      "SUMMARY" => summary = Some(unescape_ical_text(value)),
      "DESCRIPTION" => description = Some(unescape_ical_text(value)),
      "LOCATION" => location = Some(unescape_ical_text(value)),
      "STATUS" => status = Some(value.to_string()),
      "RRULE" => rrule = Some(value.to_string()),
      "RECURRENCE-ID" => recurrence_id = Some(value.to_string()),
      "DTSTART" => {
        dtstart_tzid = extract_param(params, "TZID");
        dtstart_is_date = params.to_ascii_uppercase().contains("VALUE=DATE") && !value.contains('T');
        dtstart = Some(value.to_string());
      }
      "DTEND" => {
        dtend = Some(value.to_string());
      }
      "DURATION" => {
        duration_secs = parse_duration_to_secs(value);
      }
      "ORGANIZER" => {
        organizer_email = extract_mailto(value);
      }
      "ATTENDEE" => {
        let email = extract_mailto(value);
        if let Some(email) = email {
          let display_name = extract_param(params, "CN");
          let partstat = extract_param(params, "PARTSTAT").unwrap_or_else(|| "NEEDS-ACTION".to_string());
          attendees.push(CalDavAttendee {
            email,
            display_name,
            rsvp_status: normalise_partstat(&partstat),
            is_organizer: false,
          });
        }
      }
      _ => {}
    }
  }

  trace!(event_count = events.len(), "parsed iCal VEVENT blocks");
  events
}

/// Unfold RFC 5545 continuation lines.
///
/// A continuation line is a line that starts with a single space (U+0020) or
/// horizontal tab (U+0009) character.  The leading whitespace is stripped and
/// the line is joined to the previous one.
fn unfold_ical(ical: &str) -> String {
  let mut result = String::with_capacity(ical.len());
  for line in ical.split('\n') {
    let line = line.trim_end_matches('\r');
    if line.starts_with(' ') || line.starts_with('\t') {
      result.push_str(line.trim_start());
    } else {
      if !result.is_empty() {
        result.push('\n');
      }
      result.push_str(line);
    }
  }
  result
}

/// Unescape iCalendar text-value escapes (`\n` → newline, `\\` → `\`, `\,` → `,`).
fn unescape_ical_text(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\\' {
      match chars.next() {
        Some('n') | Some('N') => out.push('\n'),
        Some('t') | Some('T') => out.push('\t'),
        Some(',') => out.push(','),
        Some(';') => out.push(';'),
        Some('\\') => out.push('\\'),
        Some(other) => {
          out.push('\\');
          out.push(other);
        }
        None => out.push('\\'),
      }
    } else {
      out.push(c);
    }
  }
  out
}

/// Extract a named parameter value from an iCalendar parameter string.
///
/// E.g. `extract_param("TZID=Europe/Berlin;VALUE=DATE-TIME", "TZID")` → `Some("Europe/Berlin")`.
fn extract_param(params: &str, name: &str) -> Option<String> {
  let prefix = format!("{name}=");
  for part in params.split(';') {
    if part.to_ascii_uppercase().starts_with(&prefix.to_ascii_uppercase()) {
      let val = &part[prefix.len()..];
      // Strip surrounding quotes if present.
      let val = val.trim_matches('"');
      if !val.is_empty() {
        return Some(val.to_string());
      }
    }
  }
  None
}

/// Extract the email address from `mailto:user@example.com` value.
fn extract_mailto(value: &str) -> Option<String> {
  // The value may be `mailto:user@host` directly or have parameters prepended.
  // We just look for `mailto:` anywhere in the value.
  if let Some(pos) = value.to_ascii_lowercase().find("mailto:") {
    let email = value[pos + 7..].trim();
    if !email.is_empty() {
      return Some(email.to_string());
    }
  }
  None
}

/// Normalise a PARTSTAT value to the `needsAction`-style strings used in the DB.
fn normalise_partstat(partstat: &str) -> String {
  match partstat.to_ascii_uppercase().as_str() {
    "ACCEPTED" => "accepted".to_string(),
    "DECLINED" => "declined".to_string(),
    "TENTATIVE" => "tentative".to_string(),
    _ => "needsAction".to_string(),
  }
}

/// Parse an iCalendar `DURATION` value (e.g. `PT1H30M`) to total seconds.
///
/// Supports: `P[n]D`, `PT[n]H[n]M[n]S`, `P[n]DT[n]H[n]M[n]S`.
fn parse_duration_to_secs(dur: &str) -> Option<i64> {
  let dur = dur.trim();
  let dur = if dur.starts_with('-') { return None } else { dur }; // negative durations unsupported
  let dur = dur.strip_prefix('P').unwrap_or(dur);

  let mut total_secs: i64 = 0;
  let (date_part, time_part) = if let Some(t_idx) = dur.find('T') {
    (&dur[..t_idx], &dur[t_idx + 1..])
  } else {
    (dur, "")
  };

  // Parse date designators: W (weeks), D (days)
  total_secs += parse_duration_part(date_part, &[('W', 7 * 86400), ('D', 86400)]);
  // Parse time designators: H (hours), M (minutes), S (seconds)
  total_secs += parse_duration_part(time_part, &[('H', 3600), ('M', 60), ('S', 1)]);

  if total_secs > 0 { Some(total_secs) } else { None }
}

fn parse_duration_part(s: &str, designators: &[(char, i64)]) -> i64 {
  let mut total: i64 = 0;
  let mut num_buf = String::new();
  for ch in s.chars() {
    if ch.is_ascii_digit() {
      num_buf.push(ch);
    } else {
      if let Some(&(_, factor)) = designators.iter().find(|(d, _)| *d == ch.to_ascii_uppercase())
        && let Ok(n) = num_buf.parse::<i64>()
      {
        total += n * factor;
      }
      num_buf.clear();
    }
  }
  total
}

/// Build a `ParsedVEvent` from the raw field strings.
struct RawVEventFields {
  uid: String,
  dtstart: Option<String>,
  dtstart_tzid: Option<String>,
  dtstart_is_date: bool,
  dtend: Option<String>,
  duration_secs: Option<i64>,
  summary: Option<String>,
  description: Option<String>,
  location: Option<String>,
  status: Option<String>,
  rrule: Option<String>,
  recurrence_id: Option<String>,
  organizer_email: Option<String>,
  attendees: Vec<CalDavAttendee>,
}

fn build_event(fields: RawVEventFields) -> Result<ParsedVEvent, String> {
  let RawVEventFields {
    uid,
    dtstart,
    dtstart_tzid,
    dtstart_is_date,
    dtend,
    duration_secs,
    summary,
    description,
    location,
    status,
    rrule,
    recurrence_id,
    organizer_email,
    attendees,
  } = fields;
  let dtstart_str = dtstart.ok_or_else(|| format!("UID {uid}: missing DTSTART"))?;
  let tzid = dtstart_tzid.clone();
  let starts_at =
    parse_ical_datetime(&dtstart_str, tzid.as_deref()).map_err(|e| format!("UID {uid}: DTSTART parse failed: {e}"))?;

  let ends_at = if let Some(ref de) = dtend {
    parse_ical_datetime(de, tzid.as_deref()).map_err(|e| format!("UID {uid}: DTEND parse failed: {e}"))?
  } else if let Some(dur) = duration_secs {
    starts_at + chrono::Duration::seconds(dur)
  } else if dtstart_is_date {
    // All-day events with no DTEND: assume 1 day.
    starts_at + chrono::Duration::days(1)
  } else {
    starts_at
  };

  Ok(ParsedVEvent {
    uid,
    starts_at,
    ends_at,
    summary,
    description,
    location,
    status,
    rrule,
    recurrence_id,
    original_timezone: dtstart_tzid,
    all_day: dtstart_is_date,
    organizer_email,
    attendees,
  })
}

/// Parse an iCalendar DATE or DATE-TIME value to `DateTime<Utc>`.
///
/// Supported formats:
/// - `19980119T070000Z` — UTC DATE-TIME (Z suffix).
/// - `19980119T070000` with TZID — local time converted to UTC via `chrono-tz`.
/// - `19980119T070000` without TZID — fallback to UTC with a warning.
/// - `19980119` — DATE only (midnight UTC).
fn parse_ical_datetime(value: &str, tzid: Option<&str>) -> Result<DateTime<Utc>, String> {
  let v = value.trim();

  // UTC DATE-TIME
  if v.len() == 16 && v.ends_with('Z') {
    // 19980119T070000Z
    return chrono::NaiveDateTime::parse_from_str(&v[..15], "%Y%m%dT%H%M%S")
      .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc))
      .map_err(|e| format!("parse UTC datetime '{v}': {e}"));
  }

  // Local DATE-TIME (no Z) — attempt TZID-aware conversion.
  if v.len() == 15 && v.contains('T') {
    let naive = chrono::NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S")
      .map_err(|e| format!("parse local datetime '{v}': {e}"))?;

    if let Some(tz_name) = tzid {
      // Try to parse the TZID into a chrono_tz timezone.
      match tz_name.parse::<chrono_tz::Tz>() {
        Ok(tz) => {
          use chrono::TimeZone;
          match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => return Ok(dt.with_timezone(&Utc)),
            chrono::LocalResult::Ambiguous(earliest, _) => {
              // DST ambiguity — use the earliest interpretation.
              trace!(tzid = %tz_name, value = %v, "ambiguous local time, using earliest");
              return Ok(earliest.with_timezone(&Utc));
            }
            chrono::LocalResult::None => {
              // Time falls in a DST gap — treat as UTC with a warning.
              warn!(
                tzid = %tz_name, value = %v,
                "local time falls in DST gap, treating as UTC"
              );
              return Ok(DateTime::from_naive_utc_and_offset(naive, Utc));
            }
          }
        }
        Err(_) => {
          warn!(
            tzid = %tz_name, value = %v,
            "unknown TZID, treating as UTC"
          );
        }
      }
    }

    // No TZID or unknown TZID — fallback to UTC.
    return Ok(DateTime::from_naive_utc_and_offset(naive, Utc));
  }

  // DATE only (e.g. 19980119)
  if v.len() == 8 {
    return chrono::NaiveDate::parse_from_str(v, "%Y%m%d")
      .map(|d| DateTime::from_naive_utc_and_offset(d.and_hms_opt(0, 0, 0).expect("midnight is valid"), Utc))
      .map_err(|e| format!("parse date '{v}': {e}"));
  }

  Err(format!("unrecognised datetime format: '{v}'"))
}

// ─── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  // ─── iCal parsing ─────────────────────────────────────────────────────────

  #[test]
  fn parse_ical_basic_vevent() {
    let ical = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
UID:event-001@example.com\r\n\
DTSTART:20260315T090000Z\r\n\
DTEND:20260315T100000Z\r\n\
SUMMARY:Team Standup\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    assert_eq!(ev.uid, "event-001@example.com");
    assert_eq!(ev.summary.as_deref(), Some("Team Standup"));
    assert_eq!(ev.starts_at.format("%Y%m%dT%H%M%SZ").to_string(), "20260315T090000Z");
    assert_eq!(ev.ends_at.format("%Y%m%dT%H%M%SZ").to_string(), "20260315T100000Z");
    assert!(!ev.all_day);
  }

  #[test]
  fn parse_ical_all_day_event() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:allday@test\r\n\
DTSTART;VALUE=DATE:20260401\r\n\
DTEND;VALUE=DATE:20260402\r\n\
SUMMARY:Annual Leave\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    assert!(events[0].all_day);
    assert_eq!(events[0].summary.as_deref(), Some("Annual Leave"));
  }

  #[test]
  fn parse_ical_line_folding() {
    // RFC 5545 §3.1: long lines fold with CRLF + SPACE.
    // Note: can't use Rust `\` continuation here — it eats the leading space.
    let ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:folded@test\r\nDTSTART:20260101T120000Z\r\nDTEND:20260101T130000Z\r\nSUMMARY:A very long summary that is folded\r\n across two lines\r\nEND:VEVENT\r\nEND:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    assert_eq!(
      events[0].summary.as_deref(),
      Some("A very long summary that is foldedacross two lines")
    );
  }

  #[test]
  fn parse_ical_duration_fallback() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:dur@test\r\n\
DTSTART:20260301T080000Z\r\n\
DURATION:PT1H30M\r\n\
SUMMARY:Duration Event\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    let dur = events[0].ends_at - events[0].starts_at;
    assert_eq!(dur.num_minutes(), 90);
  }

  #[test]
  fn parse_ical_attendees_and_organizer() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:att@test\r\n\
DTSTART:20260501T100000Z\r\n\
DTEND:20260501T110000Z\r\n\
ORGANIZER;CN=Alice:mailto:alice@example.com\r\n\
ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com\r\n\
ATTENDEE;PARTSTAT=DECLINED:mailto:carol@example.com\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    assert_eq!(ev.organizer_email.as_deref(), Some("alice@example.com"));
    assert_eq!(ev.attendees.len(), 2);
    let bob = ev.attendees.iter().find(|a| a.email == "bob@example.com").unwrap();
    assert_eq!(bob.rsvp_status, "accepted");
    let carol = ev.attendees.iter().find(|a| a.email == "carol@example.com").unwrap();
    assert_eq!(carol.rsvp_status, "declined");
  }

  #[test]
  fn parse_ical_text_escaping() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:esc@test\r\n\
DTSTART:20260601T090000Z\r\n\
DTEND:20260601T100000Z\r\n\
SUMMARY:Foo\\, Bar\r\n\
DESCRIPTION:Line1\\nLine2\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].summary.as_deref(), Some("Foo, Bar"));
    assert_eq!(events[0].description.as_deref(), Some("Line1\nLine2"));
  }

  #[test]
  fn parse_ical_multiple_vevents() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:ev1@test\r\n\
DTSTART:20260601T090000Z\r\n\
DTEND:20260601T100000Z\r\n\
SUMMARY:First\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:ev2@test\r\n\
DTSTART:20260602T090000Z\r\n\
DTEND:20260602T100000Z\r\n\
SUMMARY:Second\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].uid, "ev1@test");
    assert_eq!(events[1].uid, "ev2@test");
  }

  #[test]
  fn parse_ical_tzid_europe_berlin() {
    // DTSTART with TZID=Europe/Berlin should be converted to UTC.
    // In March 2026, Europe/Berlin is CET (UTC+1).
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:tz@test\r\n\
DTSTART;TZID=Europe/Berlin:20260315T100000\r\n\
DTEND;TZID=Europe/Berlin:20260315T110000\r\n\
SUMMARY:Berlin Meeting\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    // March 15, 2026: Europe/Berlin is CET (UTC+1), so 10:00 Berlin = 09:00 UTC.
    assert_eq!(ev.starts_at.format("%Y%m%dT%H%M%SZ").to_string(), "20260315T090000Z");
    assert_eq!(ev.ends_at.format("%Y%m%dT%H%M%SZ").to_string(), "20260315T100000Z");
    assert_eq!(ev.original_timezone.as_deref(), Some("Europe/Berlin"));
  }

  #[test]
  fn parse_ical_tzid_us_eastern() {
    // US/Eastern in March 2026 is EDT (UTC-4) after DST transition on March 8.
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:tz-us@test\r\n\
DTSTART;TZID=US/Eastern:20260315T140000\r\n\
DTEND;TZID=US/Eastern:20260315T150000\r\n\
SUMMARY:Eastern Meeting\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    // 14:00 EDT (UTC-4) = 18:00 UTC
    assert_eq!(
      events[0].starts_at.format("%Y%m%dT%H%M%SZ").to_string(),
      "20260315T180000Z"
    );
  }

  #[test]
  fn parse_ical_unknown_tzid_falls_back_to_utc() {
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:tz-bad@test\r\n\
DTSTART;TZID=Fake/Timezone:20260315T100000\r\n\
DTEND:20260315T110000Z\r\n\
SUMMARY:Fallback\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 1);
    // Unknown TZID falls back to treating as UTC.
    assert_eq!(
      events[0].starts_at.format("%Y%m%dT%H%M%SZ").to_string(),
      "20260315T100000Z"
    );
  }

  #[test]
  fn parse_ical_missing_dtstart_skipped() {
    // Event with no DTSTART must be silently skipped.
    let ical = "BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:bad@test\r\n\
SUMMARY:No Start\r\n\
END:VEVENT\r\n\
END:VCALENDAR";

    let events = parse_ical_events(ical);
    assert_eq!(events.len(), 0, "event without DTSTART must be skipped");
  }

  // ─── Duration parsing ─────────────────────────────────────────────────────

  #[test]
  fn parse_duration_pt1h() {
    assert_eq!(parse_duration_to_secs("PT1H"), Some(3600));
  }

  #[test]
  fn parse_duration_p1dt2h30m() {
    // 1 day + 2 hours + 30 minutes
    assert_eq!(parse_duration_to_secs("P1DT2H30M"), Some(86400 + 7200 + 1800));
  }

  #[test]
  fn parse_duration_p1w() {
    assert_eq!(parse_duration_to_secs("P1W"), Some(7 * 86400));
  }

  // ─── PROPFIND XML parsing ──────────────────────────────────────────────────

  #[test]
  fn parse_propfind_calendars_basic() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/alice/calendars/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>
          <D:collection/>
          <C:calendar/>
        </D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <CS:getctag>abc123</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/alice/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>
          <D:collection/>
        </D:resourcetype>
        <D:displayname>Root</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    let calendars = parse_propfind_calendars(xml).unwrap();
    // Only the calendar resource should be included, not the plain collection.
    assert_eq!(calendars.len(), 1);
    assert_eq!(calendars[0].href, "/dav/alice/calendars/personal/");
    assert_eq!(calendars[0].display_name.as_deref(), Some("Personal"));
    assert_eq!(calendars[0].ctag.as_deref(), Some("abc123"));
  }

  #[test]
  fn parse_report_calendar_data_basic() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/alice/calendars/personal/event1.ics</D:href>
    <D:propstat>
      <D:prop>
        <C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:e1@test
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    let items = parse_report_calendar_data(xml).unwrap();
    assert_eq!(items.len(), 1);
    assert!(items[0].contains("UID:e1@test"));
  }

  #[test]
  fn multiget_chunk_size_constant() {
    // Invariant: chunk size must be positive and ≤ 500 (practical server limit).
    const {
      assert!(MULTIGET_CHUNK_SIZE > 0);
      assert!(MULTIGET_CHUNK_SIZE <= 500);
    }
    // Canonical value expected by callers: 100.
    assert_eq!(MULTIGET_CHUNK_SIZE, 100);
  }

  #[test]
  fn multiget_chunks_correctly() {
    // Verify that slicing 250 hrefs into chunks of 100 gives 3 chunks.
    let hrefs: Vec<String> = (0..250).map(|i| format!("/cal/event{i}.ics")).collect();
    let chunks: Vec<&[String]> = hrefs.chunks(MULTIGET_CHUNK_SIZE).collect();
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].len(), 100);
    assert_eq!(chunks[1].len(), 100);
    assert_eq!(chunks[2].len(), 50);
  }

  // ─── INV-CAL-W03: update_event 412 → EtagConflict ────────────────────────
  //
  // Invariant: when the real CalDavClient::update_event receives a 412
  // Precondition Failed response, it returns CalDavError::EtagConflict.
  // Tests the actual production code path, not a local helper.

  /// Spawn a minimal TCP server that returns a fixed HTTP status for every
  /// request.  Returns the bound port.  The server handles exactly one connection
  /// and stops.
  async fn spawn_stub_server(status_line: &'static str) -> u16 {
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind stub server");
    let port = listener.local_addr().expect("local_addr").port();
    let response = format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    tokio::spawn(async move {
      if let Ok((mut stream, _)) = listener.accept().await {
        // Drain the request so the client doesn't get ECONNRESET
        let mut buf = [0u8; 4096];
        let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
        let _ = stream.write_all(response.as_bytes()).await;
      }
    });
    port
  }

  /// INV-CAL-W03: CalDavClient::update_event maps HTTP 412 → EtagConflict.
  ///
  /// The test drives the *real* production method (not a local helper) against a
  /// minimal stub TCP server that returns 412.
  #[tokio::test]
  async fn inv_cal_w03_update_event_412_returns_etag_conflict() {
    let port = spawn_stub_server("HTTP/1.1 412 Precondition Failed").await;
    let url = format!("http://127.0.0.1:{port}");
    let cred = CalDavCredential::Basic {
      username: "u".to_string(),
      password: "p".to_string(),
    };
    let client = CalDavClient::new(url.clone(), cred.clone(), None).expect("client");
    let href = format!("{url}/cal/event.ics");
    let result = client
      .update_event(&href, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "etag-abc", &cred)
      .await;
    assert!(
      matches!(result, Err(CalDavError::EtagConflict)),
      "INV-CAL-W03: 412 from update_event must return EtagConflict, got: {result:?}"
    );
  }

  /// INV-CAL-W04: CalDavClient::delete_event maps HTTP 404 → Ok(()).
  ///
  /// The test drives the *real* production method against a stub that returns 404.
  /// Idempotency invariant: resource already absent → no error.
  #[tokio::test]
  async fn inv_cal_w04_delete_event_404_is_idempotent() {
    let port = spawn_stub_server("HTTP/1.1 404 Not Found").await;
    let url = format!("http://127.0.0.1:{port}");
    let cred = CalDavCredential::Basic {
      username: "u".to_string(),
      password: "p".to_string(),
    };
    let client = CalDavClient::new(url.clone(), cred.clone(), None).expect("client");
    let href = format!("{url}/cal/event.ics");
    let result = client.delete_event(&href, "etag-abc", &cred).await;
    assert!(
      result.is_ok(),
      "INV-CAL-W04: 404 on delete_event must be Ok (idempotent), got: {result:?}"
    );
  }

  /// A stale ETag must preserve newer remote content instead of turning the
  /// replay-safe delete into an unconditional delete.
  #[tokio::test]
  async fn inv_cal_w05_delete_event_412_returns_etag_conflict() {
    let port = spawn_stub_server("HTTP/1.1 412 Precondition Failed").await;
    let url = format!("http://127.0.0.1:{port}");
    let cred = CalDavCredential::Basic {
      username: "u".to_string(),
      password: "p".to_string(),
    };
    let client = CalDavClient::new(url.clone(), cred.clone(), None).expect("client");
    let href = format!("{url}/cal/event.ics");
    let result = client.delete_event(&href, "etag-abc", &cred).await;
    assert!(
      matches!(result, Err(CalDavError::EtagConflict)),
      "INV-CAL-W05: 412 from delete_event must return EtagConflict, got: {result:?}"
    );
  }
}
