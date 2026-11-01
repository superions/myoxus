// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure scheduling decisions from Calendar facts loaded in the authored transaction.

use crate::entities::{CalendarEvent, CalendarEventOrigin};
use crate::repositories::{RepoResult, RepositoryError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct CalendarSchedulingRecipient {
  pub email: String,
  pub user_id: Option<Uuid>,
}

/// The last authored scheduling projection, not an SMTP completion receipt.
pub struct CalendarSchedulingState {
  pub sequence: i32,
  pub fingerprint: Value,
  pub event_snapshot: Value,
  pub recipients: Value,
}

pub struct CalendarSchedulingFacts<'a> {
  pub event: &'a CalendarEvent,
  pub kind: &'a str,
  pub instance_start: Option<DateTime<Utc>>,
  pub previous: Option<&'a CalendarSchedulingState>,
  pub parent: Option<&'a CalendarSchedulingState>,
  /// Organizer already accepted by `scheduling_organizer`.
  pub organizer_email: String,
  /// Accepted, active workspace accounts in repository order.
  pub workspace_members: Vec<CalendarSchedulingRecipient>,
}

/// The repository persists these outputs inside the event's existing transaction.
pub struct CalendarSchedulingPlan {
  pub sequence: i32,
  pub fingerprint: Value,
  pub state_snapshot: CalendarEvent,
  pub recipients: BTreeMap<String, CalendarSchedulingRecipient>,
  /// Existing calendar_mail outbox payloads in deterministic recipient order.
  pub intents: Vec<Value>,
}

/// An imported event without prior authored scheduling has nothing to cancel.
/// Evaluate this before loading organizer/account facts that cannot affect it.
pub fn scheduling_eligible(event: &CalendarEvent, kind: &str, has_previous: bool) -> bool {
  !(kind == "calendar-cancellation" && event.origin == CalendarEventOrigin::External && !has_previous)
}

/// Resolve authored scheduling authority before interpreting prior recipient state.
/// Imported attendee events cannot send as organizer.
pub fn scheduling_organizer(
  event: &CalendarEvent,
  fallback_organizer: String,
  account_owner_email: Option<&str>,
) -> Option<String> {
  let organizer = event
    .participants
    .iter()
    .find(|participant| participant.is_organizer)
    .map(|participant| participant.email.clone())
    .unwrap_or(fallback_organizer);
  if event.origin == CalendarEventOrigin::External
    && account_owner_email.is_none_or(|owner| !owner.eq_ignore_ascii_case(&organizer))
  {
    return None;
  }
  Some(organizer)
}

/// Prepare ordered intents and their authored state, or suppress an unchanged projection.
/// Organizer authority must be resolved before preparing these recipient decisions.
///
/// # Errors
/// Returns a storage error for malformed persisted recipients/occurrence snapshots
/// or an exhausted scheduling sequence.
pub fn plan_scheduling(facts: CalendarSchedulingFacts<'_>) -> RepoResult<Option<CalendarSchedulingPlan>> {
  let event = facts.event;
  let kind = facts.kind;
  let instance_start = facts.instance_start;
  let previous = facts.previous;
  let parent = facts.parent;
  // Recipient/start projection follows the event's state; sequence authority
  // follows its recurring parent when both exist.
  let prior_delivery = previous.or(parent);
  let mut recipients = BTreeMap::new();
  let organizer = facts.organizer_email;
  for participant in &event.participants {
    if !participant.is_organizer && !participant.email.eq_ignore_ascii_case(&organizer) {
      recipients.insert(
        participant.email.to_ascii_lowercase(),
        CalendarSchedulingRecipient {
          email: participant.email.clone(),
          user_id: participant.user_id,
        },
      );
    }
  }
  if event.all_members && event.workspace_id.is_some() {
    for member in facts.workspace_members {
      if !member.email.eq_ignore_ascii_case(&organizer) {
        recipients.insert(member.email.to_ascii_lowercase(), member);
      }
    }
  }
  let fingerprint = json!({"title":event.title,"start":event.starts_at,"end":event.ends_at,
    "allDay":event.all_day,"allMembers":event.all_members,"payload":scheduling_payload(&event.payload),
    "recipients":recipients,"descriptionDelta":event.description_delta});
  let previous_recipients: BTreeMap<String, CalendarSchedulingRecipient> = prior_delivery
    .map(|state| state.recipients.clone())
    .map(serde_json::from_value)
    .transpose()
    .map_err(|_| RepositoryError::Storage("Invalid calendar mail recipients".into()))?
    .unwrap_or_default();
  if kind != "calendar-cancellation" && previous.as_ref().is_some_and(|row| row.fingerprint == fingerprint) {
    return Ok(None);
  }
  let sequence = parent
    .as_ref()
    .or(previous.as_ref())
    .map(|row| {
      row
        .sequence
        .checked_add(1)
        .ok_or_else(|| RepositoryError::Storage("Calendar mail sequence exhausted".into()))
    })
    .transpose()?
    .unwrap_or(0);
  let previous_start = prior_delivery.and_then(|row| row.event_snapshot["starts_at"].as_str().map(str::to_owned));
  let mut snapshot = event.clone();
  snapshot.payload = scheduling_payload(&event.payload);
  snapshot.description_delta = None;
  snapshot.reminders.clear();
  if let Some(parent) = event.recurrence_parent_id {
    snapshot.remote_event_id = Some(parent.to_string());
  }
  // The outbound occurrence differs from the master. Preserve the stored master
  // projection so a later unchanged whole-series save does not enqueue updates.
  let occurrence_update = instance_start.is_some() && kind == "calendar-update";
  let state_snapshot = if occurrence_update {
    previous
      .as_ref()
      .map(|row| serde_json::from_value(row.event_snapshot.clone()))
      .transpose()
      .map_err(|_| RepositoryError::Storage("Invalid calendar scheduling snapshot".into()))?
      .unwrap_or_else(|| snapshot.clone())
  } else {
    snapshot.clone()
  };
  let fingerprint = if occurrence_update {
    previous
      .as_ref()
      .map(|row| row.fingerprint.clone())
      .unwrap_or(fingerprint)
  } else {
    fingerprint
  };
  if let Some(start) = instance_start {
    snapshot.payload["recurrenceId"] = json!(start.format("%Y%m%dT%H%M%SZ").to_string());
    if kind == "calendar-cancellation" {
      let duration = snapshot.ends_at - snapshot.starts_at;
      snapshot.starts_at = start;
      snapshot.ends_at = start + duration;
    }
    for key in ["rrule", "exdate", "exdates"] {
      snapshot.payload.as_object_mut().unwrap().remove(key);
    }
  }
  let mut deliveries = recipients.clone();
  for (key, recipient) in &previous_recipients {
    deliveries.entry(key.clone()).or_insert_with(|| recipient.clone());
  }
  let mut intents = Vec::new();
  for (key, recipient) in deliveries {
    let template = if kind == "calendar-cancellation" || !recipients.contains_key(&key) {
      "calendar-cancellation"
    } else if !previous_recipients.contains_key(&key) {
      "calendar-invitation"
    } else {
      kind
    };
    let intent = json!({"event":snapshot,"sequence":sequence,"template":template,"to":recipient.email,
      "userId":recipient.user_id,"organizerEmail":organizer,"previousStartsAt":previous_start,
      "workspaceId":event.workspace_id,"eventId":event.id});
    intents.push(intent);
  }
  Ok(Some(CalendarSchedulingPlan {
    sequence,
    fingerprint,
    state_snapshot,
    recipients,
    intents,
  }))
}

fn scheduling_payload(payload: &Value) -> Value {
  let mut projection = json!({});
  for key in [
    "allDay",
    "rrule",
    "exdate",
    "exdates",
    "recurrenceId",
    "description",
    "location",
  ] {
    if let Some(value) = payload.get(key) {
      projection[key] = value.clone();
    }
  }
  projection
}
