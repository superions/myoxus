// SPDX-License-Identifier: AGPL-3.0-or-later
//! Three-way merge for [`CalendarEvent`] fields.
//!
//! P90-CAL-F-03.
//!
//! When a write-back returns an ETag conflict the application fetches the
//! current remote version and calls [`merge_calendar_events`] with:
//!
//! * `base` — the event as it was when the local user last *read* it
//!   (the "ancestor" / last-known-good version).
//! * `ours`   — the local version the user is trying to save.
//! * `theirs` — the current server version (fetched after the 412).
//!
//! The algorithm applies a field-level three-way merge:
//! * Only we changed a field  → use our value.
//! * Only they changed a field → use their value.
//! * Neither changed a field  → keep base.
//! * Both changed the same field to *different* values → `Conflict`.
//! * Both changed to the *same* value → no conflict (take shared value).

use myoxus_domain::entities::CalendarEvent;

/// A single field-level conflict recorded during a three-way merge.
#[derive(Debug, Clone)]
pub struct FieldConflict {
  /// Name of the conflicting field (e.g. `"title"`, `"starts_at"`, `"payload.status"`).
  pub field: String,
  /// The value that the local side set.
  pub local_value: String,
  /// The value that the remote side set.
  pub remote_value: String,
}

/// Result returned by [`merge_calendar_events`].
#[derive(Debug, Clone)]
pub enum MergeResult {
  /// The fields were merged without any true conflict.
  Merged(Box<CalendarEvent>),
  /// At least one field was changed on both sides to different values.
  /// All conflicting fields are collected here so callers can present them
  /// to the user in a single pass.
  Conflicts(Vec<FieldConflict>),
}

/// Perform a field-level three-way merge of two calendar event versions against
/// a common base.
///
/// Returns [`MergeResult::Merged`] when all changes can be resolved
/// automatically.  Returns [`MergeResult::Conflicts`] with **all** conflicting
/// fields when any true conflict is detected.
///
/// # Panics
///
/// Does not panic.
pub fn merge_calendar_events(base: &CalendarEvent, ours: &CalendarEvent, theirs: &CalendarEvent) -> MergeResult {
  // Start with ours as the merge target; we'll overwrite with theirs where
  // theirs changed a field that ours did not touch.
  let mut merged = ours.clone();
  // Always use the latest `updated_at` timestamp.
  merged.updated_at = ours.updated_at.max(theirs.updated_at);

  // Accumulate all conflicts rather than returning on the first one.
  let mut conflicts: Vec<FieldConflict> = Vec::new();

  // Macro to merge a single Option<String> field.
  macro_rules! merge_opt_string {
    ($field:ident) => {{
      let base_val = base.$field.as_deref().unwrap_or("");
      let ours_val = ours.$field.as_deref().unwrap_or("");
      let theirs_val = theirs.$field.as_deref().unwrap_or("");

      let ours_changed = ours_val != base_val;
      let theirs_changed = theirs_val != base_val;

      match (ours_changed, theirs_changed) {
        (false, false) => { /* keep base — ours is already set to ours which == base */ }
        (true, false) => { /* keep ours — already set */ }
        (false, true) => {
          merged.$field = theirs.$field.clone();
        }
        (true, true) => {
          if ours_val != theirs_val {
            conflicts.push(FieldConflict {
              field: stringify!($field).to_string(),
              local_value: ours_val.to_string(),
              remote_value: theirs_val.to_string(),
            });
          }
          // Same change on both sides — no real conflict.
        }
      }
    }};
  }

  // ── String fields ────────────────────────────────────────────────────────
  merge_opt_string!(title);
  merge_opt_string!(description);
  merge_opt_string!(location);

  // ── Time fields ──────────────────────────────────────────────────────────
  {
    let ours_changed = ours.starts_at != base.starts_at;
    let theirs_changed = theirs.starts_at != base.starts_at;
    match (ours_changed, theirs_changed) {
      (false, false) | (true, false) => {}
      (false, true) => {
        merged.starts_at = theirs.starts_at;
      }
      (true, true) => {
        if ours.starts_at != theirs.starts_at {
          conflicts.push(FieldConflict {
            field: "starts_at".to_string(),
            local_value: ours.starts_at.to_rfc3339(),
            remote_value: theirs.starts_at.to_rfc3339(),
          });
        }
      }
    }
  }

  {
    let ours_changed = ours.ends_at != base.ends_at;
    let theirs_changed = theirs.ends_at != base.ends_at;
    match (ours_changed, theirs_changed) {
      (false, false) | (true, false) => {}
      (false, true) => {
        merged.ends_at = theirs.ends_at;
      }
      (true, true) => {
        if ours.ends_at != theirs.ends_at {
          conflicts.push(FieldConflict {
            field: "ends_at".to_string(),
            local_value: ours.ends_at.to_rfc3339(),
            remote_value: theirs.ends_at.to_rfc3339(),
          });
        }
      }
    }
  }

  // ── Payload (JSONB object) ───────────────────────────────────────────────
  // Field-level merge of top-level JSON object keys.
  if let (
    serde_json::Value::Object(base_map),
    serde_json::Value::Object(ours_map),
    serde_json::Value::Object(theirs_map),
  ) = (&base.payload, &ours.payload, &theirs.payload)
  {
    let mut result_map = ours_map.clone();
    // Collect all keys that exist in any version.
    let all_keys: std::collections::BTreeSet<&String> = base_map
      .keys()
      .chain(ours_map.keys())
      .chain(theirs_map.keys())
      .collect();

    for key in all_keys {
      let base_v = base_map.get(key);
      let ours_v = ours_map.get(key);
      let theirs_v = theirs_map.get(key);

      let ours_changed = ours_v != base_v;
      let theirs_changed = theirs_v != base_v;

      match (ours_changed, theirs_changed) {
        (false, false) | (true, false) => {}
        (false, true) => match theirs_v {
          Some(v) => {
            result_map.insert(key.clone(), v.clone());
          }
          None => {
            result_map.remove(key);
          }
        },
        (true, true) => {
          if ours_v != theirs_v {
            conflicts.push(FieldConflict {
              field: format!("payload.{key}"),
              local_value: ours_v.map(|v| v.to_string()).unwrap_or_default(),
              remote_value: theirs_v.map(|v| v.to_string()).unwrap_or_default(),
            });
          }
        }
      }
    }
    if conflicts.is_empty() {
      merged.payload = serde_json::Value::Object(result_map);
    }
  }

  if !conflicts.is_empty() {
    return MergeResult::Conflicts(conflicts);
  }

  // ETag / remote_href: always take theirs (server is authoritative for these).
  merged.etag = theirs.etag.clone();
  merged.remote_href = theirs.remote_href.clone();

  MergeResult::Merged(Box::new(merged))
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use uuid::Uuid;

  fn base_event() -> CalendarEvent {
    CalendarEvent {
      id: Uuid::new_v4(),
      origin: myoxus_domain::entities::CalendarEventOrigin::External,
      account_id: Some(Uuid::new_v4()),
      workspace_id: None,
      remote_event_id: Some("uid-base".to_string()),
      starts_at: Utc::now(),
      ends_at: Utc::now() + chrono::Duration::hours(1),
      title: Some("Base Title".to_string()),
      description: Some("Base description".to_string()),
      description_delta: None,
      location: Some("Berlin".to_string()),
      source_doc_id: None,
      all_day: false,
      all_members: false,
      tag_id: None,
      recurrence_parent_id: None,
      participants: vec![],
      reminders: vec![],
      payload: serde_json::json!({ "status": "confirmed" }),
      updated_at: Utc::now(),
      etag: Some("etag-base".to_string()),
      remote_href: Some("/cal/base.ics".to_string()),
    }
  }

  /// Scenario 1: Only local side changed title; only remote changed time.
  /// Expected: auto-merged result with our title and their time.
  #[test]
  fn merge_independent_fields_auto_merges() {
    let base = base_event();
    let mut ours = base.clone();
    ours.title = Some("Our New Title".to_string());

    let mut theirs = base.clone();
    let new_time = base.starts_at + chrono::Duration::hours(2);
    theirs.starts_at = new_time;
    theirs.ends_at = new_time + chrono::Duration::hours(1);

    let result = merge_calendar_events(&base, &ours, &theirs);
    match result {
      MergeResult::Merged(m) => {
        assert_eq!(m.title.as_deref(), Some("Our New Title"), "should keep our title");
        assert_eq!(m.starts_at, new_time, "should take their time");
      }
      MergeResult::Conflicts(cs) => panic!(
        "unexpected conflicts: {:?}",
        cs.iter().map(|c| &c.field).collect::<Vec<_>>()
      ),
    }
  }

  /// Scenario 2: Same field (title) changed on both sides to different values.
  /// Expected: Conflicts containing "title".
  #[test]
  fn merge_same_field_both_changed_signals_conflict() {
    let base = base_event();
    let mut ours = base.clone();
    ours.title = Some("Our Title".to_string());

    let mut theirs = base.clone();
    theirs.title = Some("Their Title".to_string());

    let result = merge_calendar_events(&base, &ours, &theirs);
    match result {
      MergeResult::Conflicts(cs) => {
        assert_eq!(cs.len(), 1, "expected exactly one conflict");
        assert_eq!(cs[0].field, "title");
        assert_eq!(cs[0].local_value, "Our Title");
        assert_eq!(cs[0].remote_value, "Their Title");
      }
      MergeResult::Merged(_) => panic!("expected conflict, got merged"),
    }
  }

  /// Scenario 3: Both sides changed title to the same value.
  /// Expected: No conflict — merged cleanly.
  #[test]
  fn merge_same_change_both_sides_no_conflict() {
    let base = base_event();
    let mut ours = base.clone();
    ours.title = Some("Shared New Title".to_string());

    let mut theirs = base.clone();
    theirs.title = Some("Shared New Title".to_string());

    let result = merge_calendar_events(&base, &ours, &theirs);
    match result {
      MergeResult::Merged(m) => {
        assert_eq!(m.title.as_deref(), Some("Shared New Title"));
      }
      MergeResult::Conflicts(cs) => panic!(
        "unexpected conflicts: {:?}",
        cs.iter().map(|c| &c.field).collect::<Vec<_>>()
      ),
    }
  }

  /// Scenario 4: Neither side changed anything.
  /// Expected: Merged — identical to base/ours.
  #[test]
  fn merge_no_changes_is_noop() {
    let base = base_event();
    let ours = base.clone();
    let theirs = base.clone();

    let result = merge_calendar_events(&base, &ours, &theirs);
    match result {
      MergeResult::Merged(m) => {
        assert_eq!(m.title, base.title);
        assert_eq!(m.starts_at, base.starts_at);
      }
      MergeResult::Conflicts(cs) => panic!(
        "unexpected conflicts: {:?}",
        cs.iter().map(|c| &c.field).collect::<Vec<_>>()
      ),
    }
  }
}
