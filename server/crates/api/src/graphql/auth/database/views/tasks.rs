// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed workspace Task projections on the native Views owner.
use super::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskScope", rename_items = "PascalCase")]
pub enum DatabaseTaskScopeType {
  Mine,
  All,
  Following,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskLifecycle", rename_items = "PascalCase")]
pub enum DatabaseTaskLifecycleType {
  Open,
  Closed,
  All,
  Trash,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskDuePreset", rename_items = "PascalCase")]
pub enum DatabaseTaskDuePresetType {
  Overdue,
  Today,
  NextSevenDays,
  Unscheduled,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskSort", rename_items = "PascalCase")]
pub enum DatabaseTaskSortType {
  Due,
  Priority,
  Project,
  PriorityProject,
}

#[derive(InputObject)]
pub struct DatabaseTasksInput {
  /// Omitted means the existing due-date/Row order.
  pub sort: Option<DatabaseTaskSortType>,
  pub scope: Option<DatabaseTaskScopeType>,
  pub lifecycle: Option<DatabaseTaskLifecycleType>,
  pub project_ids: Option<Vec<ID>>,
  pub assignee_id: Option<ID>,
  pub status_group: Option<DatabaseStatusGroupType>,
  pub due: Option<DatabaseTaskDuePresetType>,
  pub search: Option<String>,
  /// Match Tasks with known active prerequisites before total count and pagination.
  /// Omitted or false keeps all Tasks; unavailable capability is never a known zero.
  pub blocked_only: Option<bool>,
  pub time_zone: String,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskAssignee")]
pub struct DatabaseTaskAssigneeObjectType {
  pub id: ID,
  pub name: String,
}
#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskSummary")]
pub struct DatabaseTaskSummaryObjectType {
  pub workspace_id: ID,
  pub database_id: ID,
  pub row_id: ID,
  pub project_title: String,
  pub title: String,
  pub description_preview: Option<String>,
  pub edit_revision: i64,
  pub updated_at: DateTime<Utc>,
  pub deleted_at: Option<DateTime<Utc>>,
  pub status: Option<DatabaseStatusOptionObjectType>,
  pub assignees: Vec<DatabaseTaskAssigneeObjectType>,
  pub due: Option<DatabaseDateTimeCellValueObjectType>,
  pub priority: Option<DatabaseSelectOptionObjectType>,
  pub can_edit: bool,
  pub has_assignees: bool,
  pub has_due: bool,
  pub has_priority: bool,
  /// Null means native parent membership is unavailable or unprojected.
  pub is_subtask: Option<bool>,
  /// Known prerequisite/dependent links, including inactive ones; null is unknown.
  pub has_dependencies: Option<bool>,
  /// Null when this summary producer does not project blocker counts.
  pub blockers: Option<DatabaseTaskBlockerCountsObjectType>,
}
#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskBlockerCounts")]
pub struct DatabaseTaskBlockerCountsObjectType {
  /// Whether the canonical blocker role and source Relation Cell are readable.
  pub available: bool,
  /// Distinct active prerequisites, or null when capability is unavailable.
  pub active_count: Option<i64>,
  /// Distinct unresolved prerequisite identities; unavailable capability yields null.
  pub unresolved_count: Option<i64>,
  pub diagnostics: Vec<DatabaseTaskRelationReasonType>,
}
#[derive(SimpleObject)]
#[graphql(name = "DatabaseTasksPage")]
pub struct DatabaseTasksPageObjectType {
  pub status_options: Vec<DatabaseStatusOptionObjectType>,
  pub rows: Vec<DatabaseTaskSummaryObjectType>,
  pub total_count: i64,
  pub project_count: i64,
  pub next_cursor: Option<String>,
  pub unavailable_projects: Vec<DatabaseUnavailableProjectObjectType>,
  pub coverage_complete: bool,
}

pub(crate) async fn list_workspace_database_tasks(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: DatabaseTasksInput,
  first: Option<i32>,
  after: Option<String>,
) -> Result<DatabaseTasksPageObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let page = service(&state)?
    .views
    .list_workspace_tasks(
      snapshot.user.id,
      workspace_id,
      domain::DatabaseTasksQuery {
        sort: match input.sort.unwrap_or(DatabaseTaskSortType::Due) {
          DatabaseTaskSortType::Due => domain::DatabaseTaskSort::Due,
          DatabaseTaskSortType::Priority => domain::DatabaseTaskSort::Priority,
          DatabaseTaskSortType::Project => domain::DatabaseTaskSort::Project,
          DatabaseTaskSortType::PriorityProject => domain::DatabaseTaskSort::PriorityProject,
        },
        scope: match input.scope.unwrap_or(DatabaseTaskScopeType::Mine) {
          DatabaseTaskScopeType::Mine => domain::DatabaseTaskScope::Mine,
          DatabaseTaskScopeType::All => domain::DatabaseTaskScope::All,
          DatabaseTaskScopeType::Following => domain::DatabaseTaskScope::Following,
        },
        lifecycle: match input.lifecycle.unwrap_or(DatabaseTaskLifecycleType::Open) {
          DatabaseTaskLifecycleType::Open => domain::DatabaseTaskLifecycle::Open,
          DatabaseTaskLifecycleType::Closed => domain::DatabaseTaskLifecycle::Closed,
          DatabaseTaskLifecycleType::All => domain::DatabaseTaskLifecycle::All,
          DatabaseTaskLifecycleType::Trash => domain::DatabaseTaskLifecycle::Trash,
        },
        project_ids: input
          .project_ids
          .unwrap_or_default()
          .iter()
          .map(|id| parse_uuid_id(id, "projectId"))
          .collect::<Result<_>>()?,
        assignee_id: input
          .assignee_id
          .as_ref()
          .map(|id| parse_uuid_id(id, "assigneeId"))
          .transpose()?,
        status_group: input.status_group.map(Into::into),
        due: input.due.map(|d| match d {
          DatabaseTaskDuePresetType::Overdue => domain::DatabaseTaskDuePreset::Overdue,
          DatabaseTaskDuePresetType::Today => domain::DatabaseTaskDuePreset::Today,
          DatabaseTaskDuePresetType::NextSevenDays => domain::DatabaseTaskDuePreset::NextSevenDays,
          DatabaseTaskDuePresetType::Unscheduled => domain::DatabaseTaskDuePreset::Unscheduled,
        }),
        search: input.search,
        blocked_only: input.blocked_only.unwrap_or(false),
        time_zone: input.time_zone,
      },
      first.map(i64::from),
      after,
    )
    .await
    .map_err(map_database_error)?;
  Ok(DatabaseTasksPageObjectType {
    status_options: page.status_options.into_iter().map(map_status_option).collect(),
    total_count: page.total_count,
    project_count: page.project_count,
    next_cursor: page.next_cursor,
    rows: page.rows.into_iter().map(map_task_summary).collect(),
    unavailable_projects: page
      .unavailable_projects
      .into_iter()
      .map(map_unavailable_project)
      .collect(),
    coverage_complete: page.coverage_complete,
  })
}

pub(in crate::graphql::auth::database) fn map_task_summary(
  r: domain::DatabaseTaskSummary,
) -> DatabaseTaskSummaryObjectType {
  DatabaseTaskSummaryObjectType {
    workspace_id: r.workspace_id.to_string().into(),
    database_id: r.database_id.to_string().into(),
    row_id: r.row_id.to_string().into(),
    project_title: r.project_title,
    title: r.title,
    description_preview: r.description_preview,
    edit_revision: r.edit_revision,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
    status: r.status.map(map_status_option),
    priority: r.priority.map(map_select_option),
    assignees: r
      .assignees
      .into_iter()
      .map(|a| DatabaseTaskAssigneeObjectType {
        id: a.id.to_string().into(),
        name: a.name,
      })
      .collect(),
    due: r.due.map(|d| DatabaseDateTimeCellValueObjectType {
      start: d.start,
      end: d.end,
      all_day: d.all_day,
      time_zone: d.time_zone,
    }),
    can_edit: r.can_edit,
    has_assignees: r.has_assignees,
    has_due: r.has_due,
    has_priority: r.has_priority,
    is_subtask: r.is_subtask,
    has_dependencies: r.has_dependencies,
    blockers: r.blockers.map(|counts| DatabaseTaskBlockerCountsObjectType {
      available: counts.available,
      active_count: counts.active_count,
      unresolved_count: counts.unresolved_count,
      diagnostics: counts.diagnostics.into_iter().map(Into::into).collect(),
    }),
  }
}

#[derive(InputObject)]
pub struct DatabaseTaskReferenceInput {
  pub workspace_id: ID,
  pub database_id: ID,
  pub row_id: ID,
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "DatabaseTaskReferenceState", rename_items = "PascalCase")]
pub enum DatabaseTaskReferenceStateType {
  Available,
  Trashed,
  Unavailable,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskReference")]
pub struct DatabaseTaskReferenceObjectType {
  pub workspace_id: ID,
  pub database_id: ID,
  pub row_id: ID,
  pub state: DatabaseTaskReferenceStateType,
  pub task: Option<DatabaseTaskSummaryObjectType>,
}

pub(crate) async fn list_workspace_database_task_references(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  targets: Vec<DatabaseTaskReferenceInput>,
) -> Result<Vec<DatabaseTaskReferenceObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  let references = service(&state)?
    .views
    .list_workspace_task_references(
      snapshot.user.id,
      workspace_id,
      targets
        .into_iter()
        .map(|target| domain::DatabaseTaskReferenceTarget {
          workspace_id: target.workspace_id.to_string(),
          database_id: target.database_id.to_string(),
          row_id: target.row_id.to_string(),
        })
        .collect(),
    )
    .await
    .map_err(map_database_error)?;
  Ok(
    references
      .into_iter()
      .map(|reference| DatabaseTaskReferenceObjectType {
        workspace_id: reference.target.workspace_id.into(),
        database_id: reference.target.database_id.into(),
        row_id: reference.target.row_id.into(),
        state: match reference.state {
          domain::DatabaseTaskReferenceState::Available => DatabaseTaskReferenceStateType::Available,
          domain::DatabaseTaskReferenceState::Trashed => DatabaseTaskReferenceStateType::Trashed,
          domain::DatabaseTaskReferenceState::Unavailable => DatabaseTaskReferenceStateType::Unavailable,
        },
        task: reference.task.map(map_task_summary),
      })
      .collect(),
  )
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "DatabaseUnavailableProject")]
pub struct DatabaseUnavailableProjectObjectType {
  pub database_id: ID,
  pub title: String,
  pub reason_code: String,
}

pub(in crate::graphql::auth::database) fn map_unavailable_project(
  value: domain::DatabaseUnavailableProject,
) -> DatabaseUnavailableProjectObjectType {
  DatabaseUnavailableProjectObjectType {
    database_id: value.database_id.to_string().into(),
    title: value.title,
    reason_code: value.reason_code,
  }
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskDestination")]
pub struct DatabaseTaskDestinationObjectType {
  pub database_id: ID,
  pub title: String,
  pub edit_revision: i64,
  pub managed_schema: DatabaseManagedSchemaObjectType,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskDestinations")]
pub struct DatabaseTaskDestinationsObjectType {
  /// Canonical default identity is independent of ordinary Project pagination.
  pub default_destination: Option<DatabaseTaskDestinationObjectType>,
  pub projects: Vec<DatabaseTaskDestinationObjectType>,
  pub next_cursor: Option<ID>,
  pub unavailable_projects: Vec<DatabaseUnavailableProjectObjectType>,
  pub coverage_complete: bool,
}

pub(crate) async fn list_database_task_destinations(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  first: Option<i32>,
  after: Option<ID>,
) -> Result<DatabaseTaskDestinationsObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let page = service(&state)?
    .views
    .task_destinations(
      snapshot.user.id,
      workspace_id,
      i64::from(first.unwrap_or(100).clamp(1, 500)),
      after.as_ref().map(|id| parse_uuid_id(id, "after")).transpose()?,
    )
    .await
    .map_err(map_database_error)?;
  let map_destination = |value: domain::DatabaseTaskDestination| DatabaseTaskDestinationObjectType {
    database_id: value.database_id.to_string().into(),
    title: value.title,
    edit_revision: value.edit_revision,
    managed_schema: map_managed_schema(value.managed_schema),
  };
  Ok(DatabaseTaskDestinationsObjectType {
    default_destination: page.default_destination.map(map_destination),
    projects: page.projects.into_iter().map(map_destination).collect(),
    next_cursor: page.next_cursor.map(|id| id.to_string().into()),
    unavailable_projects: page
      .unavailable_projects
      .into_iter()
      .map(map_unavailable_project)
      .collect(),
    coverage_complete: page.coverage_complete,
  })
}
