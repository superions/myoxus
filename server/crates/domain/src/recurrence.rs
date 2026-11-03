// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Task recipes and member associations; scheduling owns all timing.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{database::*, ids::*, repositories::RepoResult, scheduling::*};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecurrenceRecipe {
  pub database_id: DatabaseId,
  pub title: String,
  pub description: Option<DatabaseRichTextValue>,
  pub assignees: Vec<UserId>,
  pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecurrenceSeries {
  /// Shared with its one canonical scheduling definition, not another timing ID.
  pub id: Uuid,
  pub workspace_id: WorkspaceId,
  pub recipe: TaskRecurrenceRecipe,
  pub current_member_id: Option<Uuid>,
  pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct TaskRecurrenceActivation {
  pub series: TaskRecurrenceSeries,
  pub member: DatabaseRowRecord,
}

#[derive(Debug, Clone)]
pub struct ConfigureTaskRecurrence {
  pub workspace_id: WorkspaceId,
  pub actor_id: UserId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub expected_row_revision: i64,
  pub expected_due_revision: i64,
  pub rule: ScheduleRule,
  pub zone: AdmissionZone,
  pub recipe: TaskRecurrenceRecipe,
}

#[derive(Debug, Clone)]
pub struct RecurrencePreviewItem {
  pub occurrence: Occurrence,
  /// Relative previews are conditional on completing at this displayed value.
  pub completion_reference: Option<ScheduleValue>,
}

#[derive(Debug, Clone)]
pub struct TaskRecurrenceMember {
  pub id: Uuid,
  pub occurrence_id: Option<Uuid>,
  pub row_id: DatabaseRowId,
  /// Captured owner for the historical association, not current Row location.
  /// Mutations resolve the live Row and authorize its actual workspace anew.
  pub database_id: DatabaseId,
  pub slot: Option<Occurrence>,
  pub advanced_at: Option<DateTime<Utc>>,
  pub advance_kind: Option<String>,
  pub successor_occurrence_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct TaskRecurrenceRead {
  pub series: TaskRecurrenceSeries,
  pub schedule: ScheduledPlan,
  pub paused_at: Option<DateTime<Utc>>,
  pub preserved_next: Option<TaskRecurrenceMember>,
  /// Last explicitly preserved member; unlike a rolling next lookup, this
  /// boundary survives the member's Due passing, edits, moves and deletion.
  pub effective_after: Option<TaskRecurrenceMember>,
  /// Accepted but not natively acknowledged work in the current generation.
  pub pending: Option<Occurrence>,
  pub members: Vec<TaskRecurrenceMember>,
}

#[derive(Debug, Clone)]
pub enum TaskRecurrenceChange {
  Pause,
  Resume,
  End,
  Update {
    rule: ScheduleRule,
    zone: AdmissionZone,
    recipe: TaskRecurrenceRecipe,
  },
}

#[derive(Debug, Clone)]
pub struct TaskRecurrenceControl {
  pub workspace_id: WorkspaceId,
  pub series_id: Uuid,
  pub actor_id: UserId,
  pub expected_revision: i64,
  pub change: TaskRecurrenceChange,
}

#[derive(Debug, Clone)]
pub struct TaskRecurrenceSkip {
  pub workspace_id: WorkspaceId,
  pub series_id: Uuid,
  pub member_id: Uuid,
  pub actor_id: UserId,
  pub expected_revision: i64,
  pub expected_row_revision: i64,
  pub expected_status_revision: i64,
}

/// Native validation is performed before confirmation and rechecked while the
/// Task Row is locked. An already committed advancement needs no second write.
#[derive(Debug, Clone)]
pub struct TaskRecurrenceSkipTarget {
  pub database_id: DatabaseId,
  pub workspace_id: WorkspaceId,
  pub row_id: DatabaseRowId,
  pub status_field_id: DatabaseFieldId,
  pub archived_option_id: String,
}

pub struct TaskRecurrenceSkipOutcome {
  pub changed_cell: Option<DatabaseCellWriteOutcome>,
  pub accepted: bool,
}

/// Application-validated adoption. Persistence rechecks the live Task, roles,
/// authority and native revisions before writing Due and the association together.
#[derive(Debug, Clone)]
pub struct AdoptTaskSeries {
  pub series: TaskRecurrenceSeries,
  pub actor_id: UserId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub expected_row_revision: i64,
  pub expected_due_revision: i64,
  pub due_field_id: DatabaseFieldId,
  pub status_field_id: DatabaseFieldId,
  pub rule: ScheduleRule,
  pub zone: AdmissionZone,
  pub first: Option<Occurrence>,
  pub next: Option<Occurrence>,
}

/// Workspace-bounded persistence, not an authorized product API. Native
/// application callers must resolve the confirming actor's current authority.
#[async_trait]
pub trait TaskRecurrenceRepository: Send + Sync {
  /// Include the requested association independently of the bounded history;
  /// prefer a non-ended series, then the newest retained series.
  async fn read_for_row(&self, workspace: WorkspaceId, row: DatabaseRowId) -> RepoResult<Option<TaskRecurrenceRead>>;
  async fn series(&self, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceSeries>>;
  async fn read(&self, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceRead>>;
  async fn list(&self, workspace: WorkspaceId, after: Option<Uuid>, first: u32) -> RepoResult<Vec<TaskRecurrenceRead>>;
  async fn member(
    &self,
    workspace: WorkspaceId,
    series: Uuid,
    member: Uuid,
  ) -> RepoResult<Option<TaskRecurrenceMember>>;
  async fn control(&self, command: TaskRecurrenceControl) -> RepoResult<()>;
  async fn skip(
    &self,
    command: TaskRecurrenceSkip,
    target: Option<TaskRecurrenceSkipTarget>,
  ) -> RepoResult<TaskRecurrenceSkipOutcome>;

  /// No mutation escapes on conflict. An unchanged first Due retains its native
  /// revision; otherwise the canonical Cell writer returns its committed delta.
  async fn adopt(
    &self,
    adoption: AdoptTaskSeries,
    reminders: Vec<DatabaseRowReminderReschedule>,
  ) -> RepoResult<Option<DatabaseCellWriteOutcome>>;

  async fn advancement_source(
    &self,
    workspace: WorkspaceId,
    series: Uuid,
    member: Uuid,
  ) -> RepoResult<Option<DatabaseRowId>>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecurrenceWake {
  pub workspace_id: WorkspaceId,
  pub schedule_id: Uuid,
  pub member_id: Uuid,
  pub generation: i64,
}
