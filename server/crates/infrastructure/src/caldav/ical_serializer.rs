// SPDX-License-Identifier: AGPL-3.0-or-later
//! iCalendar (RFC 5545) serializer for [`CalendarEvent`] domain objects.
//!
//! # Compliance
//! - RFC 5545 §3.1: CRLF line endings, line folding at 75 octets
//! - RFC 5545 §3.3.11: TEXT escaping (backslash, semicolon, comma, newline)
//! - VCALENDAR wrapper with PRODID and VERSION:2.0
//! - VALARM for reminders, ATTENDEE/ORGANIZER, RRULE/EXDATE

use chrono::Utc;
use myoxus_domain::entities::{CalendarEvent, CalendarEventParticipant, CalendarReminder};
use tracing::trace;

/// PRODID for generated iCalendar data.
const PRODID: &str = "-//Myoxus//Myoxus Calendar//EN";

// ─── Public API ───────────────────────────────────────────────────────────────

/// Serialize a [`CalendarEvent`] to a VCALENDAR string (RFC 5545).
///
/// Returns a String with CRLF line endings throughout and line folding
/// applied at 75 octets per RFC 5545 §3.1.
pub fn calendar_event_to_vcalendar(event: &CalendarEvent) -> String {
  serialize_event(event, "PUBLISH")
}

/// Normalize the configured sender mailbox to the scheduling ORGANIZER address.
pub fn normalize_scheduling_mailbox(mailbox: &str) -> Result<String, &'static str> {
  mailbox
    .parse::<lettre::message::Mailbox>()
    .map(|mailbox| mailbox.email.to_string())
    .map_err(|_| "Invalid calendar organizer")
}

/// Scheduling mail reuses the export serializer's escaping and UTF-8 folding.
/// Only the addressed attendee is included, and recurrence/sequence identity
/// remains stable across REQUEST updates and detached CANCEL messages.
pub fn calendar_event_to_scheduling(
  event: &CalendarEvent,
  sequence: i32,
  cancelled: bool,
  recipient: &str,
  organizer: &str,
) -> Result<String, &'static str> {
  recipient
    .parse::<lettre::Address>()
    .map_err(|_| "Invalid calendar attendee")?;
  organizer
    .parse::<lettre::Address>()
    .map_err(|_| "Invalid calendar organizer")?;
  let mut event = event.clone();
  event.payload = myoxus_domain::scheduling::calendar::export_payload(&event.payload, event.all_day);
  if event.all_day && event.ends_at.date_naive() <= event.starts_at.date_naive() {
    event.ends_at = event.starts_at + chrono::Duration::days(1);
  }
  let mut payload = serde_json::json!({"allDay":event.all_day,"sequence":sequence,
    "status":if cancelled {"CANCELLED"} else {"CONFIRMED"},"organizerEmail":organizer});
  for key in [
    "rrule",
    "exdate",
    "recurrenceId",
    "description",
    "location",
    "originalTimezone",
  ] {
    if let Some(value) = event.payload.get(key).filter(|value| !value.is_null()) {
      if !matches!(key, "description" | "location")
        && value.as_str().is_none_or(|value| value.chars().any(char::is_control))
      {
        return Err("Invalid calendar scheduling property");
      }
      payload[key] = value.clone();
    }
  }
  if let Some(source) = event.payload.get("sourceRecurrence") {
    payload["sourceRecurrence"] = source.clone();
  }
  if let Some(exdates) = event.payload["exdates"].as_array() {
    let dates = exdates
      .iter()
      .map(|value| {
        chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap_or_default()).map(|time| {
          time
            .with_timezone(&Utc)
            .format(if event.all_day { "%Y%m%d" } else { "%Y%m%dT%H%M%SZ" })
            .to_string()
        })
      })
      .collect::<Result<Vec<_>, _>>()
      .map_err(|_| "Invalid calendar exclusion")?;
    if !dates.is_empty() {
      let mut tokens = payload["exdate"]
        .as_str()
        .unwrap_or_default()
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
      tokens.extend(dates);
      payload["exdate"] = serde_json::json!(tokens.into_iter().collect::<Vec<_>>().join(","));
    }
  }
  if let Some(value) = payload["recurrenceId"].as_str()
    && let Ok(time) = chrono::DateTime::parse_from_rfc3339(value)
  {
    payload["recurrenceId"] = serde_json::json!(time.with_timezone(&Utc).format("%Y%m%dT%H%M%SZ").to_string());
  }
  if event.all_day
    && let Some(value) = payload["recurrenceId"].as_str()
  {
    payload["recurrenceId"] = serde_json::json!(value.get(..8).ok_or("Invalid calendar recurrence date")?);
  }
  event.payload = payload;
  event.reminders.clear();
  event.participants = vec![CalendarEventParticipant {
    id: uuid::Uuid::new_v4(),
    event_id: event.id,
    user_id: None,
    email: recipient.into(),
    display_name: None,
    response_status: "NEEDS-ACTION".into(),
    is_organizer: false,
    created_at: event.updated_at,
    updated_at: event.updated_at,
  }];
  Ok(serialize_event(&event, if cancelled { "CANCEL" } else { "REQUEST" }))
}

fn serialize_event(event: &CalendarEvent, method: &str) -> String {
  let mut projected = event.clone();
  projected.payload = myoxus_domain::scheduling::calendar::export_payload(&event.payload, event.all_day);
  let event = &projected;
  trace!(event_id = %event.id, "serializing CalendarEvent to VCALENDAR");

  let mut lines: Vec<String> = Vec::with_capacity(32);

  // VCALENDAR wrapper
  lines.push("BEGIN:VCALENDAR".to_string());
  lines.push("VERSION:2.0".to_string());
  lines.push(format!("PRODID:{PRODID}"));
  lines.push("CALSCALE:GREGORIAN".to_string());
  lines.push(format!("METHOD:{method}"));

  // VEVENT
  lines.push("BEGIN:VEVENT".to_string());

  // UID: prefer remote_event_id (stable across sync rounds), fall back to local id
  let uid = if event.origin == myoxus_domain::entities::CalendarEventOrigin::Native
    && let Some(parent) = event.recurrence_parent_id
  {
    parent.to_string()
  } else {
    event
      .remote_event_id
      .as_deref()
      .filter(|s| !s.is_empty())
      .map(|s| s.to_string())
      .unwrap_or_else(|| event.id.to_string())
  };
  lines.push(format!("UID:{}", escape_text(&uid)));

  // DTSTAMP: current UTC time
  let dtstamp = Utc::now().format("%Y%m%dT%H%M%SZ");
  lines.push(format!("DTSTAMP:{dtstamp}"));

  // DTSTART / DTEND
  let all_day = payload_bool(&event.payload, "allDay");
  if all_day {
    let dtstart = event.starts_at.format("%Y%m%d");
    let dtend = event.ends_at.format("%Y%m%d");
    lines.push(format!("DTSTART;VALUE=DATE:{dtstart}"));
    lines.push(format!("DTEND;VALUE=DATE:{dtend}"));
  } else if let Some(zone) = payload_str(&event.payload, "originalTimezone")
    .and_then(|zone| zone.parse::<chrono_tz::Tz>().ok())
    .filter(|_| payload_str(&event.payload, "rrule").is_some())
  {
    // A recurring civil time needs its pinned zone on DTSTART; UTC would turn
    // the rule into a different schedule after the next DST transition.
    lines.push(format!(
      "DTSTART;TZID={zone}:{}",
      event.starts_at.with_timezone(&zone).format("%Y%m%dT%H%M%S")
    ));
    lines.push(format!(
      "DTEND;TZID={zone}:{}",
      event.ends_at.with_timezone(&zone).format("%Y%m%dT%H%M%S")
    ));
  } else {
    let dtstart = event.starts_at.format("%Y%m%dT%H%M%SZ");
    let dtend = event.ends_at.format("%Y%m%dT%H%M%SZ");
    lines.push(format!("DTSTART:{dtstart}"));
    lines.push(format!("DTEND:{dtend}"));
  }

  // SUMMARY
  if let Some(title) = &event.title {
    lines.push(format!("SUMMARY:{}", escape_text(title)));
  } else if let Some(s) = payload_str(&event.payload, "summary") {
    lines.push(format!("SUMMARY:{}", escape_text(&s)));
  }

  // DESCRIPTION
  if let Some(desc) = payload_str(&event.payload, "description") {
    lines.push(format!("DESCRIPTION:{}", escape_text(&desc)));
  }

  // LOCATION
  if let Some(loc) = payload_str(&event.payload, "location") {
    lines.push(format!("LOCATION:{}", escape_text(&loc)));
  }

  // STATUS
  let status = payload_str(&event.payload, "status")
    .map(|s| s.to_uppercase())
    .unwrap_or_else(|| "CONFIRMED".to_string());
  // Only emit known values; default to CONFIRMED
  let status = match status.as_str() {
    "TENTATIVE" | "CANCELLED" | "CONFIRMED" => status,
    _ => "CONFIRMED".to_string(),
  };
  lines.push(format!("STATUS:{status}"));

  // TRANSP
  if let Some(transp) = payload_str(&event.payload, "transp") {
    let t = transp.to_uppercase();
    if t == "TRANSPARENT" || t == "OPAQUE" {
      lines.push(format!("TRANSP:{t}"));
    }
  }

  // PRIORITY
  if let Some(prio) = payload_i64(&event.payload, "priority")
    && (0..=9).contains(&prio)
  {
    lines.push(format!("PRIORITY:{prio}"));
  }

  // CATEGORIES
  if let Some(cats) = payload_str(&event.payload, "categories") {
    lines.push(format!("CATEGORIES:{}", escape_text(&cats)));
  }

  // URL
  if let Some(url) = payload_str(&event.payload, "url") {
    lines.push(format!("URL:{url}"));
  }

  // CLASS
  if let Some(class) = payload_str(&event.payload, "class") {
    let c = class.to_uppercase();
    if matches!(c.as_str(), "PUBLIC" | "PRIVATE" | "CONFIDENTIAL") {
      lines.push(format!("CLASS:{c}"));
    }
  }

  // CREATED / LAST-MODIFIED (use updated_at as proxy for both)
  let last_mod = event.updated_at.format("%Y%m%dT%H%M%SZ");
  lines.push(format!("CREATED:{last_mod}"));
  lines.push(format!("LAST-MODIFIED:{last_mod}"));

  // SEQUENCE (default 0; bump from payload if present)
  let seq = payload_i64(&event.payload, "sequence").unwrap_or(0).max(0);
  lines.push(format!("SEQUENCE:{seq}"));

  lines.extend(myoxus_domain::scheduling::calendar::recurrence_lines(
    &event.payload,
    all_day,
  ));

  // RECURRENCE-ID
  if let Some(source) = event.payload["sourceRecurrence"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|line| line.as_str())
    .find(|line| {
      line
        .split([';', ':'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("RECURRENCE-ID"))
        && !line.chars().any(char::is_control)
    })
  {
    lines.push(source.to_owned());
  } else if let Some(rid) = payload_str(&event.payload, "recurrenceId") {
    lines.push(format!(
      "RECURRENCE-ID{}:{rid}",
      if all_day { ";VALUE=DATE" } else { "" }
    ));
  }

  // ORGANIZER
  let organizer_email = event
    .participants
    .iter()
    .find(|p| p.is_organizer)
    .map(|p| p.email.clone())
    .or_else(|| payload_str(&event.payload, "organizerEmail"));

  if let Some(ref org_email) = organizer_email {
    let org_cn = event
      .participants
      .iter()
      .find(|p| p.is_organizer && p.email == *org_email)
      .and_then(|p| p.display_name.as_deref())
      .or(None);
    if let Some(cn) = org_cn {
      lines.push(format!("ORGANIZER;CN={}:mailto:{org_email}", escape_text(cn)));
    } else {
      lines.push(format!("ORGANIZER:mailto:{org_email}"));
    }
  }

  // ATTENDEE lines — skip the organizer (they get their own ORGANIZER: line)
  for participant in &event.participants {
    if let Some(ref org_email) = organizer_email
      && &participant.email == org_email
    {
      continue;
    }
    lines.push(format_attendee(participant));
  }

  // VALARM for each reminder
  for reminder in &event.reminders {
    lines.extend(format_valarm(reminder));
  }

  lines.push("END:VEVENT".to_string());
  lines.push("END:VCALENDAR".to_string());

  // Fold and join with CRLF
  lines
    .iter()
    .flat_map(|line| fold_line(line))
    .collect::<Vec<_>>()
    .join("\r\n")
    + "\r\n"
}

/// Serialize multiple [`CalendarEvent`]s into a single VCALENDAR string.
///
/// All events are combined into one VCALENDAR component, which is required by
/// RFC 5545 for ICS files intended for export/import.
pub fn events_to_vcalendar(events: &[&CalendarEvent]) -> String {
  trace!("serializing {} CalendarEvents to VCALENDAR", events.len());

  let mut lines: Vec<String> = Vec::with_capacity(events.len() * 20 + 6);
  lines.push("BEGIN:VCALENDAR".to_string());
  lines.push("VERSION:2.0".to_string());
  lines.push(format!("PRODID:{PRODID}"));
  lines.push("CALSCALE:GREGORIAN".to_string());
  lines.push("METHOD:PUBLISH".to_string());

  for event in events {
    // Extract VEVENT lines from single-event serialization — strip wrapper.
    let single = calendar_event_to_vcalendar(event);
    for raw_line in single.split("\r\n") {
      let clean = raw_line.to_string();
      match clean.as_str() {
        "BEGIN:VCALENDAR" | "END:VCALENDAR" | "VERSION:2.0" | "CALSCALE:GREGORIAN" | "METHOD:PUBLISH" | "" => continue,
        _ if clean.starts_with("PRODID:") => continue,
        _ => lines.push(clean),
      }
    }
  }

  lines.push("END:VCALENDAR".to_string());
  lines
    .iter()
    .flat_map(|line| fold_line(line))
    .collect::<Vec<_>>()
    .join("\r\n")
    + "\r\n"
}

// ─── Private helpers ─────────────────────────────────────────────────────────

/// RFC 5545 §3.3.11 TEXT escaping.
///
/// Must escape: backslash `\`, semicolon `;`, comma `,`, newlines (`\n`).
fn escape_text(s: &str) -> String {
  s.replace('\\', "\\\\")
    .replace(';', "\\;")
    .replace(',', "\\,")
    .replace('\n', "\\n")
    .replace('\r', "")
}

/// RFC 5545 §3.1 line folding: fold at 75 *octets* (not characters).
///
/// Returns the (possibly multi-line) folded representation as a `Vec<String>`.
/// Continuation lines begin with a single space.
fn fold_line(line: &str) -> Vec<String> {
  let bytes = line.as_bytes();
  if bytes.len() <= 75 {
    return vec![line.to_string()];
  }

  let mut result = Vec::new();
  let mut pos = 0usize;
  let mut first = true;

  while pos < bytes.len() {
    let limit = if first { 75 } else { 74 }; // leading space takes 1 octet on continuation
    // Find a safe UTF-8 boundary within `limit` bytes from pos
    let mut end = (pos + limit).min(bytes.len());
    // Walk back to a valid UTF-8 char boundary
    while end > pos && !line.is_char_boundary(end) {
      end -= 1;
    }
    if end == pos {
      // Degenerate: single multi-byte char wider than limit — push as-is
      end = (pos + 4).min(bytes.len());
      while end > pos && !line.is_char_boundary(end) {
        end -= 1;
      }
    }
    if first {
      result.push(line[pos..end].to_string());
      first = false;
    } else {
      result.push(format!(" {}", &line[pos..end]));
    }
    pos = end;
  }
  result
}

/// Format a [`CalendarEventParticipant`] as an ATTENDEE iCalendar line.
fn format_attendee(p: &CalendarEventParticipant) -> String {
  let partstat = match p.response_status.to_uppercase().as_str() {
    "ACCEPTED" => "ACCEPTED",
    "DECLINED" => "DECLINED",
    "TENTATIVE" => "TENTATIVE",
    "NEEDS-ACTION" | "NEEDSACTION" => "NEEDS-ACTION",
    _ => "NEEDS-ACTION",
  };
  let rsvp = "TRUE";

  let mut line = format!("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT={partstat};RSVP={rsvp}");
  if let Some(cn) = &p.display_name {
    line.push_str(&format!(";CN={}", escape_text(cn)));
  }
  line.push_str(&format!(":mailto:{}", p.email));
  line
}

/// Format a [`CalendarReminder`] as a VALARM block (multiple lines).
fn format_valarm(r: &CalendarReminder) -> Vec<String> {
  let trigger_min = r.minutes_before;
  vec![
    "BEGIN:VALARM".to_string(),
    "ACTION:DISPLAY".to_string(),
    "DESCRIPTION:Reminder".to_string(),
    format!("TRIGGER:-PT{trigger_min}M"),
    "END:VALARM".to_string(),
  ]
}

// ─── Payload extraction helpers ───────────────────────────────────────────────

fn payload_str(payload: &serde_json::Value, key: &str) -> Option<String> {
  payload.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn payload_bool(payload: &serde_json::Value, key: &str) -> bool {
  payload.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn payload_i64(payload: &serde_json::Value, key: &str) -> Option<i64> {
  payload.get(key).and_then(|v| v.as_i64())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::TimeZone;
  use myoxus_domain::entities::{CalendarEvent, CalendarEventParticipant, CalendarReminder};
  use serde_json::json;
  use uuid::Uuid;

  fn make_event() -> CalendarEvent {
    CalendarEvent {
      id: Uuid::new_v4(),
      origin: myoxus_domain::entities::CalendarEventOrigin::External,
      account_id: Some(Uuid::new_v4()),
      workspace_id: None,
      remote_event_id: Some("test-uid-001".to_string()),
      starts_at: Utc.with_ymd_and_hms(2026, 3, 28, 10, 0, 0).unwrap(),
      ends_at: Utc.with_ymd_and_hms(2026, 3, 28, 11, 0, 0).unwrap(),
      title: Some("Test Event".to_string()),
      description: None,
      description_delta: None,
      location: None,
      source_doc_id: None,
      all_day: false,
      all_members: false,
      tag_id: None,
      recurrence_parent_id: None,
      participants: vec![],
      reminders: vec![],
      payload: json!({}),
      updated_at: Utc.with_ymd_and_hms(2026, 3, 28, 9, 0, 0).unwrap(),
      etag: None,
      remote_href: None,
    }
  }

  // inv_cal_e06_01: minimal event produces valid VCALENDAR structure
  #[test]
  fn ical_basic_event() {
    let event = make_event();
    let output = calendar_event_to_vcalendar(&event);
    assert!(output.contains("BEGIN:VCALENDAR"), "missing BEGIN:VCALENDAR");
    assert!(output.contains("BEGIN:VEVENT"), "missing BEGIN:VEVENT");
    assert!(output.contains("END:VEVENT"), "missing END:VEVENT");
    assert!(output.contains("END:VCALENDAR"), "missing END:VCALENDAR");
    assert!(output.contains("UID:test-uid-001"), "missing UID");
    assert!(output.contains("DTSTART:20260328T100000Z"), "missing DTSTART");
    assert!(output.contains("SUMMARY:Test Event"), "missing SUMMARY");
  }

  // inv_cal_e06_02: special characters in SUMMARY are escaped per RFC 5545 §3.3.11
  #[test]
  fn ical_text_escaping() {
    let mut event = make_event();
    event.title = Some("Meeting: Alpha\\Beta; Cost: 10,000\nNew line".to_string());
    let output = calendar_event_to_vcalendar(&event);
    assert!(
      output.contains("SUMMARY:Meeting: Alpha\\\\Beta\\; Cost: 10\\,000\\nNew line"),
      "text not properly escaped: {output}"
    );
  }

  // inv_cal_e06_03: lines longer than 75 octets are folded (CRLF + space)
  #[test]
  fn ical_line_folding() {
    let mut event = make_event();
    // 100-char description
    event.payload = json!({
      "description": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });
    let output = calendar_event_to_vcalendar(&event);
    // After folding, no raw line (split by CRLF) should exceed 75 chars
    for line in output.split("\r\n") {
      assert!(
        line.len() <= 75,
        "line exceeds 75 octets ({} chars): {:?}",
        line.len(),
        line
      );
    }
    // Continuation lines (after first) must start with space
    let desc_lines: Vec<&str> = output
      .split("\r\n")
      .filter(|l| l.starts_with("DESCRIPTION") || (l.starts_with(' ') && !l.trim().is_empty()))
      .collect();
    assert!(desc_lines.len() > 1, "expected folded description, got: {desc_lines:?}");
  }

  // inv_cal_e06_04: output uses CRLF (\\r\\n) line endings throughout
  #[test]
  fn ical_crlf_endings() {
    let event = make_event();
    let output = calendar_event_to_vcalendar(&event);
    // Every line break must be CRLF
    assert!(output.contains("\r\n"), "no CRLF found in output");
    // No bare LF (without preceding CR)
    let bare_lf_count = output
      .char_indices()
      .filter(|(i, c)| *c == '\n' && (*i == 0 || output.as_bytes()[i - 1] != b'\r'))
      .count();
    assert_eq!(bare_lf_count, 0, "bare LF found in output");
  }

  // inv_cal_e06_05: all-day events use DATE format (no time component)
  #[test]
  fn ical_all_day_event() {
    let mut event = make_event();
    event.payload = json!({ "allDay": true });
    let output = calendar_event_to_vcalendar(&event);
    assert!(
      output.contains("DTSTART;VALUE=DATE:20260328"),
      "all-day DTSTART must be DATE format, got: {output}"
    );
    assert!(
      output.contains("DTEND;VALUE=DATE:20260328"),
      "all-day DTEND must be DATE format"
    );
    // Must NOT contain DATE-TIME format for DTSTART
    assert!(
      !output.contains("DTSTART:20260328T"),
      "all-day event must not emit DATE-TIME DTSTART"
    );
  }

  // Additional: ATTENDEE lines contain PARTSTAT and mailto
  #[test]
  fn ical_attendees() {
    let mut event = make_event();
    event.participants = vec![
      CalendarEventParticipant {
        id: Uuid::new_v4(),
        event_id: event.id,
        user_id: None,
        email: "alice@example.com".to_string(),
        display_name: Some("Alice".to_string()),
        response_status: "accepted".to_string(),
        is_organizer: false,
        created_at: event.updated_at,
        updated_at: event.updated_at,
      },
      CalendarEventParticipant {
        id: Uuid::new_v4(),
        event_id: event.id,
        user_id: None,
        email: "bob@example.com".to_string(),
        display_name: None,
        response_status: "needsaction".to_string(),
        is_organizer: true,
        created_at: event.updated_at,
        updated_at: event.updated_at,
      },
    ];
    let output = calendar_event_to_vcalendar(&event);
    assert!(output.contains("ATTENDEE;"), "no ATTENDEE line");
    assert!(output.contains("PARTSTAT=ACCEPTED"), "ACCEPTED not found");
    assert!(output.contains(":mailto:alice@example.com"), "alice email not found");
    assert!(
      output.contains("ORGANIZER:mailto:bob@example.com"),
      "ORGANIZER not found"
    );
  }

  // Additional: VALARM block emitted for reminders
  #[test]
  fn ical_valarm_reminder() {
    let mut event = make_event();
    event.reminders = vec![CalendarReminder {
      id: Uuid::new_v4(),
      event_id: event.id,
      channel: "display".to_string(),
      minutes_before: 15,
      scheduled_for: event.starts_at,
      delivered_at: None,
      created_at: event.updated_at,
      updated_at: event.updated_at,
    }];
    let output = calendar_event_to_vcalendar(&event);
    assert!(output.contains("BEGIN:VALARM"), "no VALARM");
    assert!(output.contains("TRIGGER:-PT15M"), "wrong trigger");
    assert!(output.contains("ACTION:DISPLAY"), "wrong action");
  }

  // B-07: organizer must not appear in ATTENDEE lines
  #[test]
  fn ical_organizer_not_in_attendee_list() {
    let mut event = make_event();
    event.participants = vec![
      CalendarEventParticipant {
        id: Uuid::new_v4(),
        event_id: event.id,
        user_id: None,
        email: "org@example.com".to_string(),
        display_name: Some("Organizer".to_string()),
        response_status: "accepted".to_string(),
        is_organizer: true,
        created_at: event.updated_at,
        updated_at: event.updated_at,
      },
      CalendarEventParticipant {
        id: Uuid::new_v4(),
        event_id: event.id,
        user_id: None,
        email: "alice@example.com".to_string(),
        display_name: Some("Alice".to_string()),
        response_status: "accepted".to_string(),
        is_organizer: false,
        created_at: event.updated_at,
        updated_at: event.updated_at,
      },
      CalendarEventParticipant {
        id: Uuid::new_v4(),
        event_id: event.id,
        user_id: None,
        email: "bob@example.com".to_string(),
        display_name: None,
        response_status: "needs-action".to_string(),
        is_organizer: false,
        created_at: event.updated_at,
        updated_at: event.updated_at,
      },
    ];
    let output = calendar_event_to_vcalendar(&event);
    // Exactly 1 ORGANIZER line
    let organizer_count = output.lines().filter(|l| l.starts_with("ORGANIZER")).count();
    assert_eq!(organizer_count, 1, "must have exactly 1 ORGANIZER line");
    // Exactly 2 ATTENDEE lines (not 3)
    let attendee_count = output.lines().filter(|l| l.starts_with("ATTENDEE")).count();
    assert_eq!(
      attendee_count, 2,
      "must have exactly 2 ATTENDEE lines (organizer excluded)"
    );
    // org@example.com must NOT appear in any ATTENDEE line
    let org_in_attendee = output
      .lines()
      .any(|l| l.starts_with("ATTENDEE") && l.contains("org@example.com"));
    assert!(!org_in_attendee, "organizer email must not appear in any ATTENDEE line");
  }

  // B-08: DTSTART must use UTC Z-form, not TZID= form
  #[test]
  fn ical_dtstart_uses_utc_z_form() {
    let mut event = make_event();
    // Set timezone in payload to trigger the old TZID= path
    event.payload = json!({ "timezone": "America/New_York" });
    let output = calendar_event_to_vcalendar(&event);
    // DTSTART line must end with Z
    let dtstart_line = output.lines().find(|l| l.starts_with("DTSTART")).expect("no DTSTART");
    assert!(
      dtstart_line.contains('Z'),
      "DTSTART must use Z-suffix UTC form; got: {dtstart_line}"
    );
    assert!(
      !dtstart_line.contains("TZID="),
      "DTSTART must not use TZID= form; got: {dtstart_line}"
    );
  }

  // Additional: RRULE emitted when present in payload
  #[test]
  fn ical_rrule() {
    let mut event = make_event();
    event.payload = json!({ "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR" });
    let output = calendar_event_to_vcalendar(&event);
    assert!(
      output.contains("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"),
      "RRULE not found in output"
    );
  }
  #[test]
  fn scheduling_attachments_keep_uid_sequence_and_only_the_target_attendee() {
    let mut event = make_event();
    event.all_day = true;
    event.payload = json!({"location":"Room A","recurrenceId":"20261012T000000Z"});
    event.starts_at = "2026-10-12T00:00:00Z".parse().unwrap();
    event.ends_at = event.starts_at;
    let request =
      calendar_event_to_scheduling(&event, 3, false, "reader@example.test", "organizer@example.test").expect("REQUEST");
    let cancel =
      calendar_event_to_scheduling(&event, 4, true, "reader@example.test", "organizer@example.test").expect("CANCEL");
    for (ics, sequence, method) in [(&request, 3, "REQUEST"), (&cancel, 4, "CANCEL")] {
      assert!(ics.contains("UID:test-uid-001\r\n"));
      assert!(ics.contains(&format!("METHOD:{method}\r\n")));
      assert!(ics.contains(&format!("SEQUENCE:{sequence}\r\n")));
      assert!(ics.contains("DTSTART;VALUE=DATE:20261012\r\n"));
      assert!(ics.contains("DTEND;VALUE=DATE:20261013\r\n"));
      assert!(ics.contains("RECURRENCE-ID;VALUE=DATE:20261012\r\n"));
      assert!(ics.contains("mailto:reader@example.test"));
      assert!(!ics.contains("BEGIN:VALARM"));
    }
    assert!(cancel.contains("STATUS:CANCELLED"));
    event.payload = json!({"rrule":"FREQ=DAILY\r\nATTENDEE:mailto:leak@example.test"});
    assert!(calendar_event_to_scheduling(&event, 0, false, "reader@example.test", "organizer@example.test").is_err());
  }
}
