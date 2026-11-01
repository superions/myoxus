// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native View Task query projections.
use crate::database::*;

/// Workspace Task filters describe native Project Rows only. Optional roles are
/// resolved by semantic key and task scope, independently of display names.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTasksQuery {
  pub scope: DatabaseTaskScope,
  pub lifecycle: DatabaseTaskLifecycle,
  #[serde(default)]
  pub sort: DatabaseTaskSort,
  pub project_ids: Vec<DatabaseId>,
  pub assignee_id: Option<UserId>,
  pub status_group: Option<DatabaseStatusGroup>,
  pub due: Option<DatabaseTaskDuePreset>,
  pub search: Option<String>,
  /// Only known active prerequisites match; unresolved capability is not zero.
  #[serde(default)]
  pub blocked_only: bool,
  pub time_zone: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseTaskScope {
  #[default]
  Mine,
  All,
  Following,
}

/// Inventory ordering is evaluated before paging; it never writes Task rank.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseTaskSort {
  #[default]
  Due,
  Priority,
  Project,
  PriorityProject,
}

/// Evaluated SQL keys, not a later reconstruction from mutable Task metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskSortKey {
  pub priority_rank: i32,
  /// Folded native Project name/ID; both absent for Workspace Tasks.
  pub project_name: Option<String>,
  pub project_id: Option<DatabaseId>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseTaskLifecycle {
  #[default]
  Open,
  Closed,
  /// All non-trashed Tasks, independently of their concrete status.
  All,
  Trash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseTaskDuePreset {
  Overdue,
  Today,
  NextSevenDays,
  Unscheduled,
}

/// Continuations retain the evaluated clock/window and key, not a snapshot of
/// membership. A changed identity or filter must start a new first page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTasksCursor {
  pub workspace_id: WorkspaceId,
  pub actor_id: UserId,
  pub query: DatabaseTasksQuery,
  pub evaluated_at: DateTime<Utc>,
  pub due_start: Option<DateTime<Utc>>,
  pub row_id: DatabaseRowId,
  /// Absent in existing Due continuations, which retain their original order.
  #[serde(default)]
  pub sort_key: Option<DatabaseTaskSortKey>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTasksRead {
  pub workspace_id: WorkspaceId,
  pub actor_id: UserId,
  pub query: DatabaseTasksQuery,
  pub evaluated_at: DateTime<Utc>,
  pub local_today: NaiveDate,
  pub local_window_end: NaiveDate,
  pub today_start: DateTime<Utc>,
  pub today_end: DateTime<Utc>,
  pub window_end: DateTime<Utc>,
  pub after: Option<DatabaseTasksCursor>,
  pub limit: i64,
  pub can_edit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskAssignee {
  pub id: UserId,
  pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskSummary {
  /// Internal inventory continuation projection; never exposed by the API.
  #[serde(default, skip_serializing)]
  pub sort_key: Option<DatabaseTaskSortKey>,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub project_title: String,
  pub title: String,
  /// Plain-text excerpt for inventory rows, bounded to 280 characters.
  pub description_preview: Option<String>,
  pub edit_revision: i64,
  pub updated_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub status: Option<DatabaseStatusOption>,
  pub assignees: Vec<DatabaseTaskAssignee>,
  pub due: Option<DatabaseDateTimeValue>,
  pub priority: Option<DatabaseSelectOption>,
  pub can_edit: bool,
  pub has_assignees: bool,
  pub has_due: bool,
  pub has_priority: bool,
  /// Native visible parent membership; null means unavailable or unprojected.
  #[serde(default)]
  pub is_subtask: Option<bool>,
  /// Known outgoing/inverse prerequisite links, including inactive links.
  /// Null means unavailable or unprojected; no related identities are exposed.
  #[serde(default)]
  pub has_dependencies: Option<bool>,
  /// None means this summary producer did not project blockers. The cockpit
  /// always projects capability, including explicit unavailable/null counts.
  #[serde(default)]
  pub blockers: Option<DatabaseTaskBlockerCounts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskBlockerCounts {
  pub available: bool,
  /// Distinct prerequisite identities; null when capability/Cell is unreadable.
  pub active_count: Option<i64>,
  pub unresolved_count: Option<i64>,
  pub diagnostics: Vec<DatabaseTaskRelationReason>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTasksPage {
  /// Concrete admitted Status options, in native order, including empty columns.
  pub status_options: Vec<DatabaseStatusOption>,
  pub unavailable_projects: Vec<DatabaseUnavailableProject>,
  pub coverage_complete: bool,
  pub rows: Vec<DatabaseTaskSummary>,
  pub total_count: i64,
  /// Authorized live Projects before filters; zero distinguishes unavailable
  /// Project destinations from a healthy empty Task result.
  pub project_count: i64,
  pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DatabaseTaskBlockingState {
  Active,
  Inactive,
  Unavailable,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskBlockingEntry {
  /// An outgoing unresolved ID belongs to the authorized source Cell only.
  pub row_id: DatabaseRowId,
  /// Edge activity: outgoing uses the listed prerequisite; inverse uses the
  /// current source prerequisite, while `task` identifies the listed dependent.
  pub state: DatabaseTaskBlockingState,
  pub task: Option<DatabaseTaskSummary>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskBlockingPage {
  pub available: bool,
  pub field_id: Option<DatabaseFieldId>,
  pub diagnostics: Vec<DatabaseTaskRelationReason>,
  /// Outgoing only: exact canonical IDs, including duplicate/invalid legacy IDs.
  pub retained_row_ids: Vec<DatabaseRowId>,
  pub rows: Vec<DatabaseTaskBlockingEntry>,
  pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskBlockingRead {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub inverse: bool,
  pub after: Option<DatabaseRowId>,
  pub limit: i64,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskParentProjection {
  /// Compatible Task capability; invalid legacy edges may still be diagnosed.
  pub available: bool,
  pub field_id: Option<DatabaseFieldId>,
  /// IDs from the authorized Row's own Cell, including invalid/unresolved IDs.
  pub parent_row_ids: Vec<DatabaseRowId>,
  pub diagnostics: Vec<DatabaseTaskRelationReason>,
}

/// One canonical Parent capability/count/page snapshot. Optional Task summary
/// fields never determine child membership; Archived is distinct from Complete.
#[derive(Debug, Clone)]
pub struct DatabaseTaskChildrenPage {
  pub available: bool,
  pub field_id: Option<DatabaseFieldId>,
  pub diagnostics: Vec<DatabaseTaskRelationReason>,
  pub rows: Vec<DatabaseTaskSummary>,
  pub total_count: i64,
  pub complete_count: i64,
  pub archived_count: i64,
  pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskChildrenRead {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub parent_row_id: DatabaseRowId,
  pub after: Option<DatabaseRowId>,
  pub limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskDestination {
  pub edit_revision: i64,
  pub database_id: DatabaseId,
  pub title: String,
  pub managed_schema: DatabaseManagedSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseUnavailableProject {
  pub database_id: DatabaseId,
  pub title: String,
  pub reason_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTaskDestinations {
  pub default_destination: Option<DatabaseTaskDestination>,
  pub projects: Vec<DatabaseTaskDestination>,
  pub next_cursor: Option<DatabaseId>,
  pub unavailable_projects: Vec<DatabaseUnavailableProject>,
  pub coverage_complete: bool,
}

/// Reference payload identity is explicit even when an individual editor target
/// is malformed. Readers echo it without resolving a foreign scope locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseTaskReferenceTarget {
  pub workspace_id: String,
  pub database_id: String,
  pub row_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseTaskReferenceState {
  Available,
  Trashed,
  Unavailable,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskReference {
  pub target: DatabaseTaskReferenceTarget,
  pub state: DatabaseTaskReferenceState,
  pub task: Option<DatabaseTaskSummary>,
}

/// Distinct, valid native pairs admitted by the containing workspace's reader.
#[derive(Debug, Clone)]
pub struct DatabaseTaskReferencesRead {
  pub workspace_id: WorkspaceId,
  pub targets: Vec<(DatabaseId, DatabaseRowId)>,
}

#[derive(Debug, Clone)]
pub struct DatabaseTaskReferenceRecord {
  pub task: DatabaseTaskSummary,
  pub project_deleted_at: Option<DateTime<Utc>>,
}
