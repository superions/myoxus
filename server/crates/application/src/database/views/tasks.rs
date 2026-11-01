// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative workspace Task read normalization and continuation identity.

use super::access;
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono_tz::Tz;

#[derive(Serialize, Deserialize)]
struct TaskChildrenCursor {
  actor_id: UserId,
  workspace_id: WorkspaceId,
  database_id: DatabaseId,
  parent_row_id: DatabaseRowId,
  field_id: DatabaseFieldId,
  row_id: DatabaseRowId,
}

#[derive(Serialize, Deserialize)]
struct TaskBlockingCursor {
  actor_id: UserId,
  workspace_id: WorkspaceId,
  database_id: DatabaseId,
  source_row_id: DatabaseRowId,
  inverse: bool,
  field_id: DatabaseFieldId,
  row_id: DatabaseRowId,
}

impl DatabaseViewService {
  /// Resolve a bounded canonical direction without writing status, dates or
  /// mirrored Cells. Cursor identity includes actor, current owner and direction.
  #[instrument(skip_all)]
  pub async fn task_blocking(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    inverse: bool,
    first: Option<i64>,
    after: Option<String>,
  ) -> DatabaseResult<DatabaseTaskBlockingPage> {
    let workspace_id = self.task_children_owner(actor, database_id).await?;
    let invalid = || DatabaseServiceError::new(ERR_QUERY_INVALID, "invalid Task blocking continuation");
    let cursor: Option<TaskBlockingCursor> = after
      .map(|raw| {
        if raw.len() > 2048 {
          return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
        let cursor: TaskBlockingCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if cursor.actor_id != actor
          || cursor.workspace_id != workspace_id
          || cursor.database_id != database_id
          || cursor.source_row_id != row_id
          || cursor.inverse != inverse
        {
          return Err(invalid());
        }
        Ok(cursor)
      })
      .transpose()?;
    let mut page = self
      .view_query_repo
      .task_blocking(DatabaseTaskBlockingRead {
        workspace_id,
        database_id,
        row_id,
        inverse,
        after: cursor.as_ref().map(|cursor| cursor.row_id),
        limit: first
          .unwrap_or(self.limits.default_rows_per_page)
          .clamp(1, self.limits.max_rows_per_page),
      })
      .await?;
    if page.available
      && cursor
        .as_ref()
        .is_some_and(|cursor| Some(cursor.field_id) != page.field_id)
    {
      return Err(invalid());
    }
    if self.task_children_owner(actor, database_id).await? != workspace_id {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"));
    }
    let can_edit = self
      .permission
      .can(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        WorkspaceAction::CreateDoc,
      )
      .await;
    for entry in &mut page.rows {
      if let Some(task) = &mut entry.task {
        task.can_edit = can_edit && task.deleted_at.is_none();
      }
    }
    if page.next_cursor.is_some() {
      page.next_cursor = page
        .rows
        .last()
        .zip(page.field_id)
        .map(|(entry, field_id)| {
          serde_json::to_vec(&TaskBlockingCursor {
            actor_id: actor,
            workspace_id,
            database_id,
            source_row_id: row_id,
            inverse,
            field_id,
            row_id: entry.row_id,
          })
          .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        })
        .transpose()
        .map_err(|_| invalid())?;
    }
    Ok(page)
  }

  /// Read one detail's canonical children; this projection never updates the
  /// parent's manual progress, completion, assignment or scheduling Cells.
  #[instrument(skip_all)]
  pub async fn task_children(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    first: Option<i64>,
    after: Option<String>,
  ) -> DatabaseResult<DatabaseTaskChildrenPage> {
    let workspace_id = self.task_children_owner(actor, database_id).await?;
    let invalid = || DatabaseServiceError::new(ERR_QUERY_INVALID, "invalid task children continuation");
    let cursor: Option<TaskChildrenCursor> = after
      .map(|raw| {
        if raw.len() > 2048 {
          return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
        let cursor: TaskChildrenCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if cursor.actor_id != actor
          || cursor.workspace_id != workspace_id
          || cursor.database_id != database_id
          || cursor.parent_row_id != row_id
        {
          return Err(invalid());
        }
        Ok(cursor)
      })
      .transpose()?;
    let mut page = self
      .view_query_repo
      .task_children(DatabaseTaskChildrenRead {
        workspace_id,
        database_id,
        parent_row_id: row_id,
        after: cursor.as_ref().map(|cursor| cursor.row_id),
        limit: first
          .unwrap_or(self.limits.default_rows_per_page)
          .clamp(1, self.limits.max_rows_per_page),
      })
      .await?;
    // Optional capability removal supersedes a field-bound continuation;
    // actor/workspace/Database/Parent identity was still checked above.
    if page.available
      && cursor
        .as_ref()
        .is_some_and(|cursor| Some(cursor.field_id) != page.field_id)
    {
      return Err(invalid());
    }
    // Move/revocation during the repository snapshot must not authorize a stale
    // workspace summary merely because the caller once owned that workspace.
    let current_workspace = self.task_children_owner(actor, database_id).await?;
    if current_workspace != workspace_id {
      return Err(DatabaseServiceError::new(ERR_NOT_FOUND, "database row not found"));
    }
    let can_edit = self
      .permission
      .can(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        WorkspaceAction::CreateDoc,
      )
      .await;
    for row in &mut page.rows {
      row.can_edit = can_edit;
    }
    if page.next_cursor.is_some() {
      page.next_cursor = page
        .rows
        .last()
        .zip(page.field_id)
        .map(|(row, field_id)| {
          serde_json::to_vec(&TaskChildrenCursor {
            actor_id: actor,
            workspace_id,
            database_id,
            parent_row_id: row_id,
            field_id,
            row_id: row.row_id,
          })
          .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        })
        .transpose()
        .map_err(|_| invalid())?;
    }
    Ok(page)
  }

  pub(in crate::database) async fn task_children_owner(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<WorkspaceId> {
    // Use the established identity/summary port: optional field corruption must
    // not make canonical child membership depend on a full schema aggregate.
    let database = self
      .view_query_repo
      .get_database_summary(database_id, DatabaseLifecycleFilter::Any)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database not found"))?;
    access::assert_workspace(&self.permission, actor, database.workspace_id, WorkspaceAction::Read).await?;
    Ok(database.workspace_id)
  }

  /// Keep input positions and duplicates while admitting only explicit current
  /// workspace UUID pairs. Unavailable targets never carry a cached summary.
  #[instrument(skip_all)]
  pub async fn list_workspace_task_references(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    targets: Vec<DatabaseTaskReferenceTarget>,
  ) -> DatabaseResult<Vec<DatabaseTaskReference>> {
    if targets.len() > 500 {
      return Err(DatabaseServiceError::new(
        ERR_QUERY_INVALID,
        "task reference batch exceeds 500 targets",
      ));
    }
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let admitted = targets
      .iter()
      .map(|target| {
        let scope = Uuid::parse_str(&target.workspace_id).ok()?;
        if scope != workspace_id {
          return None;
        }
        Some((
          Uuid::parse_str(&target.database_id).ok()?,
          Uuid::parse_str(&target.row_id).ok()?,
        ))
      })
      .collect::<Vec<_>>();
    let distinct = admitted.iter().flatten().copied().collect::<BTreeSet<_>>();
    let records = if distinct.is_empty() {
      Vec::new()
    } else {
      self
        .view_query_repo
        .list_workspace_task_references(DatabaseTaskReferencesRead {
          workspace_id,
          targets: distinct.into_iter().collect(),
        })
        .await?
    };
    let can_edit = self
      .permission
      .can(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        WorkspaceAction::CreateDoc,
      )
      .await;
    // Rendering must not retain a summary after the containing workspace's
    // read capability was revoked during the bounded repository read.
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let records = records
      .into_iter()
      .map(|mut record| {
        let trashed = record.project_deleted_at.is_some() || record.task.deleted_at.is_some();
        record.task.can_edit = can_edit && !trashed;
        (record.task.row_id, (trashed, record.task))
      })
      .collect::<HashMap<_, _>>();
    Ok(
      targets
        .into_iter()
        .zip(admitted)
        .map(|(target, pair)| {
          let task = pair.and_then(|(_, row_id)| records.get(&row_id));
          let mut target = target;
          if let Some((_, task)) = task {
            target.database_id = task.database_id.to_string();
          }
          DatabaseTaskReference {
            target,
            state: match task {
              Some((true, _)) => DatabaseTaskReferenceState::Trashed,
              Some((false, _)) => DatabaseTaskReferenceState::Available,
              None => DatabaseTaskReferenceState::Unavailable,
            },
            task: task.map(|(_, task)| task.clone()),
          }
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  pub async fn list_workspace_tasks(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    mut query: DatabaseTasksQuery,
    first: Option<i64>,
    after: Option<String>,
  ) -> DatabaseResult<DatabaseTasksPage> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    let invalid = || DatabaseServiceError::new(ERR_QUERY_INVALID, "invalid task query or continuation");
    let zone = query.time_zone.parse::<Tz>().map_err(|_| invalid())?;
    query.project_ids.sort_unstable();
    query.project_ids.dedup();
    if query.project_ids.len() > 500 || query.search.as_ref().is_some_and(|s| s.chars().count() > 200) {
      return Err(invalid());
    }
    query.search = query.search.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cursor: Option<DatabaseTasksCursor> = after
      .map(|raw| {
        if raw.len() > 32768 {
          return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
        let cursor: DatabaseTasksCursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if cursor.workspace_id != workspace_id || cursor.actor_id != actor || cursor.query != query {
          return Err(invalid());
        }
        if query.sort != DatabaseTaskSort::Due && cursor.sort_key.is_none() {
          return Err(invalid());
        }
        if cursor.sort_key.as_ref().is_some_and(|key| {
          !(0..=5).contains(&key.priority_rank) || key.project_name.is_some() != key.project_id.is_some()
        }) {
          return Err(invalid());
        }
        Ok(cursor)
      })
      .transpose()?;
    let evaluated_at = cursor.as_ref().map(|c| c.evaluated_at).unwrap_or_else(Utc::now);
    let today = evaluated_at.with_timezone(&zone).date_naive();
    let tomorrow = today.succ_opt().ok_or_else(invalid)?;
    let end = today.checked_add_signed(Duration::days(7)).ok_or_else(invalid)?;
    let can_edit = self
      .permission
      .can(
        &WorkspaceResource {
          user_id: actor,
          workspace_id,
        },
        WorkspaceAction::CreateDoc,
      )
      .await;
    let mut page = self
      .view_query_repo
      .list_workspace_tasks(DatabaseTasksRead {
        workspace_id,
        actor_id: actor,
        query: query.clone(),
        evaluated_at,
        local_today: today,
        local_window_end: end,
        today_start: task_day_boundary(zone, today)?,
        today_end: task_day_boundary(zone, tomorrow)?,
        window_end: task_day_boundary(zone, end)?,
        after: cursor,
        limit: first
          .unwrap_or(self.limits.default_rows_per_page)
          .clamp(1, self.limits.max_rows_per_page),
        can_edit,
      })
      .await
      .map_err(|error| match error {
        RepositoryError::Validation(message) if message.starts_with("database task unavailable") => {
          DatabaseServiceError::new("MIX_DATABASE_TASK_UNAVAILABLE", message)
        }
        error => error.into(),
      })?;
    // The repository fetches one extra row so a terminal page never advertises
    // a continuation merely because its count included preceding rows.
    if page.next_cursor.is_some() {
      page.next_cursor = page
        .rows
        .last()
        .map(|row| {
          let cursor = DatabaseTasksCursor {
            workspace_id,
            actor_id: actor,
            query,
            evaluated_at,
            due_start: row.due.as_ref().map(|due| due.start),
            row_id: row.row_id,
            sort_key: row.sort_key.clone(),
          };
          serde_json::to_vec(&cursor).map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        })
        .transpose()
        .map_err(|_| invalid())?;
    }
    Ok(page)
  }
}

fn task_day_boundary(zone: Tz, date: NaiveDate) -> DatabaseResult<DateTime<Utc>> {
  // Some IANA zones advance at midnight. The first representable instant of
  // that local day, and the earlier instant on a fold, delimit calendar days.
  for minute in 0..1440 {
    let local = date
      .and_hms_opt(minute / 60, minute % 60, 0)
      .ok_or_else(|| DatabaseServiceError::new(ERR_QUERY_INVALID, "invalid task date window"))?;
    if let Some(value) = zone.from_local_datetime(&local).earliest() {
      return Ok(value.with_timezone(&Utc));
    }
  }
  Err(DatabaseServiceError::new(
    ERR_QUERY_INVALID,
    "task calendar day is unavailable",
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  pub(in crate::database) fn task_calendar_windows_follow_dst_and_midnight_gaps() {
    let berlin: Tz = "Europe/Berlin".parse().expect("zone");
    let spring = NaiveDate::from_ymd_opt(2026, 3, 29).expect("date");
    let start = task_day_boundary(berlin, spring).expect("start");
    let end = task_day_boundary(berlin, spring.succ_opt().expect("tomorrow")).expect("end");
    assert_eq!((end - start).num_hours(), 23);
    let autumn = NaiveDate::from_ymd_opt(2026, 10, 25).expect("date");
    assert_eq!(
      (task_day_boundary(berlin, autumn.succ_opt().expect("tomorrow")).expect("end")
        - task_day_boundary(berlin, autumn).expect("start"))
      .num_hours(),
      25
    );
    let sao_paulo: Tz = "America/Sao_Paulo".parse().expect("zone");
    let midnight_gap = NaiveDate::from_ymd_opt(2018, 11, 4).expect("date");
    assert_eq!(
      task_day_boundary(sao_paulo, midnight_gap)
        .expect("gap day")
        .with_timezone(&sao_paulo)
        .date_naive(),
      midnight_gap
    );
  }
}

impl DatabaseViewService {
  pub async fn task_destinations(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    first: i64,
    after: Option<DatabaseId>,
  ) -> DatabaseResult<DatabaseTaskDestinations> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    self
      .view_query_repo
      .task_destinations(workspace_id, first.clamp(1, 100), after)
      .await
      .map_err(Into::into)
  }
}
