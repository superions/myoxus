// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-JCAL-SERVER-02: NativeEventService — workspace-native calendar event mutations.
//!
//! Invariants enforced here (in addition to DB-level CHECK constraints):
//! - INV-CAL-NATIVE-02: only native events may be mutated; external → Err
//! - INV-CAL-NATIVE-03: caller must have workspace write permission (CreateDoc)
//! - INV-CAL-SCOPE-01:  scope=This creates an override row + adds EXDATE to master
//! - INV-CAL-SCOPE-02:  scope=All edits the master directly, overrides untouched

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tracing::{debug, instrument};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult, AuthStore};
use myoxus_domain::entities::{CalendarEvent, CalendarEventOrigin, CalendarReminder};
use myoxus_domain::ids::{CalendarEventId, CalendarEventTagId, DocId, WorkspaceId};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::{
  CalendarEventSourceAnchor, CalendarRepository, NativeEventInput, NativeEventReminderInput, NativeEventUpdate,
};

// ── Broadcast port ────────────────────────────────────────────────────────────

/// Port for pushing realtime `calendar:event_changed` signals to workspace rooms.
///
/// SERVER-04 wires up the Socket.io implementation; until then the no-op default
/// is used so the service can be built and tested independently.
#[async_trait]
pub trait CalendarBroadcastPort: Send + Sync {
  async fn broadcast_event_changed(&self, workspace_id: WorkspaceId, event_id: CalendarEventId, op: &str);
}

/// No-op broadcast: discards every signal.
pub struct NullCalendarBroadcast;

#[async_trait]
impl CalendarBroadcastPort for NullCalendarBroadcast {
  async fn broadcast_event_changed(&self, _ws: WorkspaceId, _id: CalendarEventId, _op: &str) {}
}

// ── Input / output types ──────────────────────────────────────────────────────

/// Scope of a recurring-event mutation.
#[derive(Debug, Clone)]
pub enum UpdateScope {
  /// Edit the master event and all future instances.
  All,
  /// Create an override for a single occurrence at `instance_start`.
  This {
    instance_start: DateTime<Utc>,
  },
  ThisAndFuture {
    instance_start: DateTime<Utc>,
  },
}

/// Scope of a recurring-event delete.
#[derive(Debug, Clone)]
pub enum DeleteScope {
  /// Delete the master event (and all overrides via FK cascade).
  All,
  /// Exclude one occurrence by adding its start time to the master's EXDATE list.
  This {
    instance_start: DateTime<Utc>,
  },
  ThisAndFuture {
    instance_start: DateTime<Utc>,
  },
}

#[derive(Debug, thiserror::Error)]
pub enum CalendarTimingControlError {
  #[error(transparent)]
  Auth(#[from] AuthError),
  #[error("Calendar recurrence revision changed")]
  Conflict,
}

/// A single reminder the caller wants attached to an event.
#[derive(Debug, Clone)]
pub struct ReminderInput {
  pub minutes_before: i32,
  pub channel: String,
}

/// Input DTO for creating a workspace-native event.
#[derive(Debug, Clone)]
pub struct NativeCreateInput {
  pub imported_recurrence: Option<myoxus_domain::scheduling::calendar::ImportedCalendarSource>,
  pub recurrence: Option<myoxus_domain::scheduling::RecurrenceRule>,
  pub title: Option<String>,
  pub description_delta: Option<Value>,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub all_day: bool,
  pub all_members: bool,
  pub tag_id: Option<CalendarEventTagId>,
  pub source_doc_id: Option<DocId>,
  pub source_anchor: Option<CalendarEventSourceAnchor>,
  /// Omitted uses the workspace default; an explicit empty set disables it.
  pub reminders: Option<Vec<ReminderInput>>,
}

/// A conflicting event detected by `check_conflicts`.
#[derive(Debug, Clone)]
pub struct EventOverlap {
  pub event_id: CalendarEventId,
  pub starts_at: DateTime<Utc>,
  pub ends_at: DateTime<Utc>,
  pub title: Option<String>,
}

// ── Service ───────────────────────────────────────────────────────────────────

/// Application service for workspace-native calendar event mutations.
///
/// Enforces INV-CAL-NATIVE-02/03, scope semantics (SCOPE-01/02), writeback
/// enqueueing (WRITEBACK-01), default-reminder scheduling (REMINDER-01), and
/// realtime broadcast (REALTIME-01 — via injected port, no-op until SERVER-04).
#[derive(Clone)]
pub struct NativeEventService {
  repo: Arc<dyn CalendarRepository>,
  auth_store: Arc<dyn AuthStore>,
  broadcast: Arc<dyn CalendarBroadcastPort>,
}

impl NativeEventService {
  pub fn new(repo: Arc<dyn CalendarRepository>, auth_store: Arc<dyn AuthStore>) -> Self {
    Self {
      repo,
      auth_store,
      broadcast: Arc::new(NullCalendarBroadcast),
    }
  }

  pub fn with_broadcast(mut self, b: Arc<dyn CalendarBroadcastPort>) -> Self {
    self.broadcast = b;
    self
  }

  // ── Permission helper ─────────────────────────────────────────────────

  async fn assert_write_access(&self, workspace_id: WorkspaceId, user_id: Uuid) -> AuthResult<()> {
    let role = self.auth_store.get_workspace_role(user_id, workspace_id).await?;
    match role {
      Some(r) if r.can(WorkspaceAction::CreateDoc) => Ok(()),
      _ => Err(AuthError::ActionForbidden),
    }
  }

  // ── Writeback helper ──────────────────────────────────────────────────

  async fn maybe_enqueue_writeback(&self, workspace_id: WorkspaceId, event_id: CalendarEventId, op: &str) {
    if let Ok(Some(s)) = self.repo.get_workspace_calendar_settings(workspace_id).await
      && s.writeback_subscription_id.is_some()
    {
      let _ = self.repo.enqueue_pending_write(event_id, op, None).await;
    }
  }

  // ── Reminder helper ───────────────────────────────────────────────────

  async fn schedule_reminders(
    &self,
    event_id: CalendarEventId,
    starts_at: DateTime<Utc>,
    workspace_id: WorkspaceId,
    explicit: Option<&[ReminderInput]>,
  ) -> AuthResult<()> {
    let inputs: Vec<ReminderInput> = if explicit.is_none() {
      // Fall back to workspace default offset
      if let Ok(Some(s)) = self.repo.get_workspace_calendar_settings(workspace_id).await {
        if let Some(offset) = s.default_reminder_offset_minutes {
          vec![ReminderInput {
            minutes_before: offset,
            channel: "in_app".to_string(),
          }]
        } else {
          vec![]
        }
      } else {
        vec![]
      }
    } else {
      explicit.unwrap_or_default().to_vec()
    };

    if inputs.is_empty() {
      return Ok(());
    }

    let now = Utc::now();
    let reminders: Vec<CalendarReminder> = inputs
      .into_iter()
      .map(|r| CalendarReminder {
        id: Uuid::new_v4(),
        event_id,
        channel: r.channel,
        minutes_before: r.minutes_before,
        scheduled_for: starts_at - chrono::Duration::minutes(r.minutes_before as i64),
        delivered_at: None,
        created_at: now,
        updated_at: now,
      })
      .collect();

    self
      .repo
      .replace_calendar_event_reminders(event_id, &reminders)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  /// Replace reminders for an update after the event mutation has passed all
  /// authorization and native-origin checks. The repository owns the atomic
  /// delete/insert operation; this service owns IDs and derived trigger times.
  async fn replace_update_reminders(
    &self,
    event_id: CalendarEventId,
    starts_at: DateTime<Utc>,
    inputs: &[NativeEventReminderInput],
  ) -> AuthResult<()> {
    let now = Utc::now();
    let reminders = inputs
      .iter()
      .map(|input| CalendarReminder {
        id: Uuid::new_v4(),
        event_id,
        channel: input.channel.clone(),
        minutes_before: input.minutes_before,
        scheduled_for: starts_at - chrono::Duration::minutes(input.minutes_before as i64),
        delivered_at: None,
        created_at: now,
        updated_at: now,
      })
      .collect::<Vec<_>>();
    self
      .repo
      .replace_calendar_event_reminders(event_id, &reminders)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  // ── Public API ────────────────────────────────────────────────────────

  fn validate_recurrence(
    rule: &myoxus_domain::scheduling::RecurrenceRule,
    start: DateTime<Utc>,
    all_day: bool,
  ) -> AuthResult<()> {
    myoxus_domain::scheduling::calendar::validate_native_rule(rule, start, all_day)
      .map_err(|_| AuthError::InvalidInput("recurrence start and date kind must match the native event".into()))
  }

  /// Create a new workspace-native event.
  ///
  /// Enforces INV-CAL-NATIVE-03 (workspace write permission).
  #[instrument(skip(self, input))]
  pub async fn create(
    &self,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    input: NativeCreateInput,
  ) -> AuthResult<CalendarEvent> {
    self.create_with_parent(workspace_id, user_id, input, None).await
  }

  /// Imported exceptions can bind only to a uniquely identified master created
  /// by this batch. Never search existing workspace UIDs and adopt foreign data.
  #[instrument(skip_all)]
  pub async fn import_sources(
    &self,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    mut inputs: Vec<NativeCreateInput>,
  ) -> AuthResult<Vec<(String, AuthResult<CalendarEvent>)>> {
    self.assert_write_access(workspace_id, user_id).await?;
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for source in inputs
      .iter()
      .filter_map(|input| input.imported_recurrence.as_ref())
      .filter(|source| source.recurrence_id.is_none())
    {
      *counts.entry(source.uid.clone()).or_default() += 1;
    }
    inputs.sort_by_key(|input| {
      input
        .imported_recurrence
        .as_ref()
        .is_some_and(|source| source.recurrence_id.is_some())
    });
    let mut masters = std::collections::HashMap::new();
    let mut results = Vec::new();
    for mut input in inputs {
      let source = input
        .imported_recurrence
        .as_ref()
        .ok_or_else(|| AuthError::InvalidInput("imported Calendar source missing".into()))?;
      let uid = source.uid.clone();
      let parent = if let Some(raw) = &source.recurrence_id {
        let Some(parent) = masters.get(&uid).copied() else {
          results.push((
            uid,
            Err(AuthError::InvalidInput(
              "Calendar exception has no unique imported master".into(),
            )),
          ));
          continue;
        };
        let timing = self
          .repo
          .get_calendar_timing(parent)
          .await
          .map_err(|error| AuthError::Storage(error.to_string()))?;
        let Some(timing) = timing else {
          results.push((
            uid,
            Err(AuthError::InvalidInput(
              "Calendar exception master has no recurrence".into(),
            )),
          ));
          continue;
        };
        let key = match super::projection::imported_original_key(raw, &source.lines, timing.zone) {
          Ok(key) => key,
          Err(_) => {
            results.push((
              uid,
              Err(AuthError::InvalidInput("unsupported Calendar recurrence ID".into())),
            ));
            continue;
          }
        };
        input
          .imported_recurrence
          .as_mut()
          .expect("source checked")
          .recurrence_id = Some(key.format("%Y%m%dT%H%M%SZ").to_string());
        Some((parent, key))
      } else {
        if counts.get(&uid) != Some(&1) {
          results.push((
            uid,
            Err(AuthError::InvalidInput("duplicate imported Calendar master UID".into())),
          ));
          continue;
        }
        None
      };
      let result = self.create_with_parent(workspace_id, user_id, input, parent).await;
      if parent.is_none()
        && let Ok(event) = &result
      {
        masters.insert(uid.clone(), event.id);
      }
      results.push((uid, result));
    }
    Ok(results)
  }

  async fn create_with_parent(
    &self,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    mut input: NativeCreateInput,
    parent: Option<(Uuid, DateTime<Utc>)>,
  ) -> AuthResult<CalendarEvent> {
    self.assert_write_access(workspace_id, user_id).await?;
    if input.recurrence.is_some() && input.imported_recurrence.is_some() {
      return Err(AuthError::InvalidInput(
        "Calendar recurrence has two source owners".into(),
      ));
    }
    input.recurrence = input
      .recurrence
      .map(myoxus_domain::scheduling::calendar::canonical_rule);
    if let Some(rule) = &input.recurrence {
      Self::validate_recurrence(rule, input.starts_at, input.all_day)?;
    }
    if input.ends_at < input.starts_at {
      return Err(AuthError::InvalidInput(
        "calendar event ends_at must be greater than or equal to starts_at".to_string(),
      ));
    }
    if input
      .reminders
      .iter()
      .flatten()
      .any(|reminder| reminder.minutes_before < 0)
    {
      return Err(AuthError::InvalidInput(
        "reminder minutes_before must be non-negative".to_string(),
      ));
    }

    let repo_input = NativeEventInput {
      imported_recurrence: input.imported_recurrence,
      recurrence: input.recurrence.map(
        |rule| myoxus_domain::scheduling::calendar::ConfirmedCalendarRecurrence {
          rule,
          actor_id: user_id,
        },
      ),
      workspace_id,
      title: input.title,
      description_delta: input.description_delta,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      all_day: input.all_day,
      all_members: input.all_members,
      tag_id: input.tag_id,
      source_doc_id: input.source_doc_id,
      source_anchor: input.source_anchor,
      recurrence_parent_id: parent.map(|(id, _)| id),
      recurrence_ical_id: parent.map(|(_, key)| key.format("%Y%m%dT%H%M%SZ").to_string()),
    };
    let event = self
      .repo
      .insert_native_event(&repo_input)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?;

    self
      .schedule_reminders(event.id, event.starts_at, workspace_id, input.reminders.as_deref())
      .await?;
    // Return the stored reminder channels so an immediate edit preserves them.
    let event = self
      .repo
      .get_calendar_event(event.id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("native event disappeared after creation".into()))?;
    self.maybe_enqueue_writeback(workspace_id, event.id, "create").await;
    self
      .broadcast
      .broadcast_event_changed(workspace_id, event.id, "created")
      .await;

    debug!(event_id = %event.id, workspace_id = %workspace_id, "native event created");
    Ok(event)
  }

  /// Update a workspace-native event.
  ///
  /// - scope=All: edits the master event in-place (INV-CAL-SCOPE-02).
  /// - scope=This: adds an EXDATE to the master and creates an override row
  ///   with `recurrence_parent_id` pointing at the master (INV-CAL-SCOPE-01).
  ///
  /// - scope=ThisAndFuture: atomically truncates the master and creates a native
  ///   tail, retaining original keys, finite limits and relevant exceptions.
  ///
  /// Returns `Err(ActionForbidden)` if the event is external (INV-CAL-NATIVE-02).
  #[instrument(skip(self, update))]
  pub async fn update(
    &self,
    event_id: CalendarEventId,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    scope: UpdateScope,
    mut update: NativeEventUpdate,
  ) -> AuthResult<CalendarEvent> {
    self.assert_write_access(workspace_id, user_id).await?;

    // Fetch master and verify it is native.
    let master = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".into()))?;

    if master.workspace_id != Some(workspace_id) {
      return Err(AuthError::ActionForbidden);
    }
    if master.origin != CalendarEventOrigin::Native {
      return Err(AuthError::ActionForbidden); // INV-CAL-NATIVE-02
    }
    let exception = master.recurrence_parent_id.is_some()
      || master.payload["recurrenceId"]
        .as_str()
        .is_some_and(|value| !value.is_empty());
    if update.recurrence.is_some() && (matches!(scope, UpdateScope::This { .. }) || exception) {
      return Err(AuthError::InvalidInput(
        "only a Calendar master All or ThisAndFuture edit can change its rule".into(),
      ));
    }
    if update.recurrence.is_some()
      && let Some(timing) = self
        .repo
        .get_calendar_timing(event_id)
        .await
        .map_err(|e| AuthError::Storage(e.to_string()))?
      && !matches!(
        timing.rule,
        Some(myoxus_domain::scheduling::calendar::CalendarTimingRule::Fixed { .. })
      )
    {
      return Err(AuthError::InvalidInput(
        "imported Calendar recurrence is read-only".into(),
      ));
    }
    if matches!(scope, UpdateScope::All)
      && master.recurrence_parent_id.is_none()
      && update.recurrence.is_none()
      && (update.starts_at.is_some() || update.all_day.is_some())
    {
      if let Some(timing) = self
        .repo
        .get_calendar_timing(event_id)
        .await
        .map_err(|e| AuthError::Storage(e.to_string()))?
      {
        match timing.rule {
          Some(myoxus_domain::scheduling::calendar::CalendarTimingRule::Fixed { rule }) => {
            let start = update.starts_at.unwrap_or(master.starts_at);
            let rule = myoxus_domain::scheduling::calendar::rule_with_start(
              &rule,
              start,
              update.all_day.unwrap_or(master.all_day),
            );
            update.recurrence = Some(Some(myoxus_domain::scheduling::calendar::ConfirmedCalendarRecurrence {
              rule,
              actor_id: user_id,
            }));
          }
          _ => {
            return Err(AuthError::InvalidInput(
              "imported Calendar recurrence is read-only".into(),
            ));
          }
        }
      }
    }
    if let Some(Some(recurrence)) = &mut update.recurrence {
      recurrence.rule = myoxus_domain::scheduling::calendar::canonical_rule(recurrence.rule.clone());
      recurrence.actor_id = user_id;
      Self::validate_recurrence(
        &recurrence.rule,
        update.starts_at.unwrap_or(match &scope {
          UpdateScope::ThisAndFuture { instance_start } => *instance_start,
          _ => master.starts_at,
        }),
        update.all_day.unwrap_or(master.all_day),
      )?;
    }

    if update
      .reminders
      .as_ref()
      .is_some_and(|inputs| inputs.iter().any(|input| input.minutes_before < 0))
    {
      return Err(AuthError::InvalidInput(
        "reminder minutes_before must be non-negative".to_string(),
      ));
    }

    let (effective_starts_at, effective_ends_at) = match &scope {
      UpdateScope::All => (
        update.starts_at.unwrap_or(master.starts_at),
        update.ends_at.unwrap_or(master.ends_at),
      ),
      UpdateScope::This { instance_start } | UpdateScope::ThisAndFuture { instance_start } => {
        let starts_at = update.starts_at.unwrap_or(*instance_start);
        let ends_at = update
          .ends_at
          .unwrap_or(starts_at + (master.ends_at - master.starts_at));
        (starts_at, ends_at)
      }
    };
    if effective_ends_at < effective_starts_at {
      return Err(AuthError::InvalidInput(
        "calendar event ends_at must be greater than or equal to starts_at".to_string(),
      ));
    }

    let reminders_patch = update.reminders.clone();
    let is_single_occurrence = matches!(&scope, UpdateScope::This { .. });
    let event = match scope {
      UpdateScope::All => self
        .repo
        .update_native_event(event_id, &update)
        .await
        .map_err(|e| AuthError::Storage(e.to_string()))?
        .ok_or_else(|| AuthError::NotFound("native event not found or became external".into()))?,
      UpdateScope::This { instance_start } => {
        // The repository saves the master exclusion, stable override and mail
        // intent together; retries reuse the occurrence identity.
        // Compute override duration from master (or use updated times if provided).
        let duration = master.ends_at - master.starts_at;
        let override_starts = update.starts_at.unwrap_or(instance_start);
        let override_ends = update.ends_at.unwrap_or(override_starts + duration);

        let override_input = NativeEventInput {
          imported_recurrence: None,
          recurrence: None,
          workspace_id,
          title: update.title.flatten().or(master.title),
          description_delta: update.description_delta.flatten().or(master.description_delta),
          starts_at: override_starts,
          ends_at: override_ends,
          all_day: update.all_day.unwrap_or(master.all_day),
          all_members: update.all_members.unwrap_or(master.all_members),
          tag_id: update.tag_id.flatten().or(master.tag_id),
          source_doc_id: update.source_doc_id.flatten().or(master.source_doc_id),
          source_anchor: update.source_anchor.clone().flatten(),
          recurrence_parent_id: Some(event_id),
          recurrence_ical_id: Some(instance_start.format("%Y%m%dT%H%M%SZ").to_string()),
        };
        self
          .repo
          .insert_native_event(&override_input)
          .await
          .map_err(|e| AuthError::Storage(e.to_string()))?
      }
      UpdateScope::ThisAndFuture { instance_start } => {
        super::CalendarService::new(self.repo.clone())
          .split_native_series(event_id, user_id, instance_start, update, true)
          .await?
      }
    };

    let event = self
      .repo
      .get_calendar_event(event.id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("native event disappeared after update".into()))?;

    // For a single-occurrence override, omitted reminders inherit the
    // master's effective set. An explicit empty list still clears them.
    let reminders_to_apply = reminders_patch.or_else(|| {
      if is_single_occurrence {
        Some(
          master
            .reminders
            .iter()
            .map(|reminder| NativeEventReminderInput {
              minutes_before: reminder.minutes_before,
              channel: reminder.channel.clone(),
            })
            .collect(),
        )
      } else {
        None
      }
    });
    if let Some(reminders) = reminders_to_apply.as_deref() {
      let mut requested = reminders
        .iter()
        .map(|reminder| {
          (
            reminder.channel.as_str(),
            reminder.minutes_before,
            event.starts_at - chrono::Duration::minutes(reminder.minutes_before as i64),
          )
        })
        .collect::<Vec<_>>();
      let mut saved = event
        .reminders
        .iter()
        .map(|reminder| {
          (
            reminder.channel.as_str(),
            reminder.minutes_before,
            reminder.scheduled_for,
          )
        })
        .collect::<Vec<_>>();
      requested.sort_unstable();
      saved.sort_unstable();
      // Identical patches retain reminder IDs and completed delivery receipts.
      if requested != saved {
        self
          .replace_update_reminders(event.id, event.starts_at, reminders)
          .await?;
      }
    }
    let event = self
      .repo
      .get_calendar_event(event.id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("native event disappeared after update".into()))?;

    self.maybe_enqueue_writeback(workspace_id, event_id, "update").await;
    if event.id != event_id && !is_single_occurrence {
      self.maybe_enqueue_writeback(workspace_id, event.id, "create").await;
      self
        .broadcast
        .broadcast_event_changed(workspace_id, event.id, "created")
        .await;
    }
    self
      .broadcast
      .broadcast_event_changed(workspace_id, event_id, "updated")
      .await;

    debug!(event_id = %event_id, workspace_id = %workspace_id, "native event updated");
    Ok(event)
  }

  /// Explicit native lifecycle control fences source revisions, never changes
  /// the pinned rule and uses the same permissions/writeback as event edits.
  #[instrument(skip_all)]
  pub async fn control_recurrence(
    &self,
    event_id: CalendarEventId,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    expected_revision: i64,
    change: myoxus_domain::scheduling::calendar::CalendarTimingChange,
  ) -> Result<CalendarEvent, CalendarTimingControlError> {
    self.assert_write_access(workspace_id, user_id).await?;
    let event = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event".into()))?;
    if event.workspace_id != Some(workspace_id)
      || event.origin != CalendarEventOrigin::Native
      || event.recurrence_parent_id.is_some()
    {
      return Err(AuthError::ActionForbidden.into());
    }
    let event = self
      .repo
      .control_calendar_timing(event_id, user_id, expected_revision, change)
      .await
      .map_err(|error| match error {
        myoxus_domain::repositories::RepositoryError::Conflict(_) => CalendarTimingControlError::Conflict,
        myoxus_domain::repositories::RepositoryError::Validation(message) => AuthError::InvalidInput(message).into(),
        error => AuthError::Storage(error.to_string()).into(),
      })?;
    self.maybe_enqueue_writeback(workspace_id, event_id, "update").await;
    self
      .broadcast
      .broadcast_event_changed(workspace_id, event_id, "updated")
      .await;
    Ok(event)
  }

  /// Delete a workspace-native event.
  ///
  /// - scope=All: deletes the master row (FK cascade removes overrides).
  /// - scope=This: adds EXDATE to master, excluding the single instance.
  /// - scope=ThisAndFuture: retains the master and suppresses its addressed
  ///   original slot and later ones; no temporary tail is created.
  ///
  /// Returns `Err(ActionForbidden)` if the event is external.
  #[instrument(skip(self))]
  pub async fn delete(
    &self,
    event_id: CalendarEventId,
    workspace_id: WorkspaceId,
    user_id: Uuid,
    scope: DeleteScope,
  ) -> AuthResult<()> {
    self.assert_write_access(workspace_id, user_id).await?;

    let event = self
      .repo
      .get_calendar_event(event_id)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
      .ok_or_else(|| AuthError::NotFound("calendar event not found".into()))?;

    if event.workspace_id != Some(workspace_id) {
      return Err(AuthError::ActionForbidden);
    }
    if event.origin != CalendarEventOrigin::Native {
      return Err(AuthError::ActionForbidden); // INV-CAL-NATIVE-02
    }

    let change = match scope {
      DeleteScope::All => {
        super::stage_calendar_event_delete(self.repo.as_ref(), event_id).await?;
        "deleted"
      }
      DeleteScope::This { instance_start } => {
        self
          .repo
          .cancel_calendar_occurrence(event_id, instance_start)
          .await
          .map_err(|e| AuthError::Storage(e.to_string()))?;
        self.maybe_enqueue_writeback(workspace_id, event_id, "update").await;
        "updated"
      }
      DeleteScope::ThisAndFuture { instance_start } => {
        super::CalendarService::new(self.repo.clone())
          .split_native_series(event_id, user_id, instance_start, NativeEventUpdate::default(), false)
          .await?;
        self.maybe_enqueue_writeback(workspace_id, event_id, "update").await;
        "updated"
      }
    };
    self
      .broadcast
      .broadcast_event_changed(workspace_id, event_id, change)
      .await;

    debug!(event_id = %event_id, workspace_id = %workspace_id, "native event deleted");
    Ok(())
  }

  /// Return all native and external events in the workspace that overlap
  /// `[from, to)`, excluding `exclude_id` if given.
  ///
  /// The returned list is purely informational; the caller decides whether
  /// to surface a warning (INV-CAL-CONFLICT-01).
  #[instrument(skip(self))]
  pub async fn check_conflicts(
    &self,
    workspace_id: WorkspaceId,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    exclude_id: Option<CalendarEventId>,
  ) -> AuthResult<Vec<EventOverlap>> {
    let events = self
      .repo
      .list_workspace_events(workspace_id, from, to)
      .await
      .map_err(super::read_error)?;

    let overlaps = events
      .into_iter()
      .filter(|e| exclude_id != Some(e.id))
      .map(|e| EventOverlap {
        event_id: e.id,
        starts_at: e.starts_at,
        ends_at: e.ends_at,
        title: e.title,
      })
      .collect();

    Ok(overlaps)
  }
}
