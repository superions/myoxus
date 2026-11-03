// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scoped native controls; timing remains on the canonical scheduling row.
use super::*;
use chrono::{DateTime, Utc};

fn conflict() -> RepositoryError {
  RepositoryError::Conflict("task recurrence series revision")
}

pub(super) fn map_member(row: sqlx::postgres::PgRow) -> RepoResult<TaskRecurrenceMember> {
  let nominal: Option<serde_json::Value> = row.try_get("nominal_json").map_err(storage)?;
  let due: Option<DateTime<Utc>> = row.try_get("nominal_due_at").map_err(storage)?;
  let slot = match (nominal, due) {
    (Some(nominal), Some(due_at)) => Some(Occurrence {
      nominal: serde_json::from_value(nominal).map_err(storage)?,
      due_at,
    }),
    (None, None) => None,
    _ => return Err(invalid()),
  };
  Ok(TaskRecurrenceMember {
    id: row.try_get("id").map_err(storage)?,
    occurrence_id: row.try_get("occurrence_id").map_err(storage)?,
    row_id: row.try_get("row_id").map_err(storage)?,
    database_id: row.try_get("database_id").map_err(storage)?,
    slot,
    advanced_at: row.try_get("advanced_at").map_err(storage)?,
    advance_kind: row.try_get("advance_kind").map_err(storage)?,
    successor_occurrence_id: row.try_get("successor_occurrence_id").map_err(storage)?,
  })
}

pub(super) async fn member_in(
  tx: &mut PgConnection,
  workspace: WorkspaceId,
  series: Uuid,
  member: Uuid,
) -> RepoResult<Option<TaskRecurrenceMember>> {
  sqlx::query("SELECT m.*,o.nominal_json,o.nominal_due_at FROM task_recurrence_members m JOIN task_recurrence_series s ON s.id=m.series_id LEFT JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE s.workspace_id=$1 AND s.id=$2 AND m.id=$3")
    .bind(workspace).bind(series).bind(member).fetch_optional(tx).await.map_err(storage)?.map(map_member).transpose()
}

async fn read_in(tx: &mut PgConnection, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceRead>> {
  let series = sqlx::query("SELECT * FROM task_recurrence_series WHERE workspace_id=$1 AND id=$2")
    .bind(workspace)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?;
  let Some(series) = series else { return Ok(None) };
  let boundary: Option<Uuid> = series.try_get("effective_after_member_id").map_err(storage)?;
  let series = TaskRecurrenceSeries {
    id,
    workspace_id: workspace,
    recipe: serde_json::from_value(series.try_get("recipe_json").map_err(storage)?).map_err(storage)?,
    current_member_id: series.try_get("current_member_id").map_err(storage)?,
    created_at: series.try_get("created_at").map_err(storage)?,
  };
  let plan = sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND workspace_id=$2")
    .bind(id)
    .bind(workspace)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let paused_at = plan.try_get("paused_at").map_err(storage)?;
  let schedule = PgSchedulingRepository::map_plan(plan)?;
  // A bounded recent history is not the authority for the independent next or
  // explicit-member lookups; an old/closed Task stays addressable by identity.
  let rows=sqlx::query("SELECT m.*,o.nominal_json,o.nominal_due_at FROM task_recurrence_members m LEFT JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE m.series_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100")
    .bind(id).fetch_all(&mut *tx).await.map_err(storage)?;
  let members = rows.into_iter().map(map_member).collect::<RepoResult<Vec<_>>>()?;
  let preserved_next = if matches!(schedule.rule, Some(ScheduleRule::AfterCompletion { .. })) {
    if let Some(member) = series.current_member_id {
      member_in(tx, workspace, id, member)
        .await?
        .filter(|member| member.advanced_at.is_none())
    } else {
      None
    }
  } else {
    sqlx::query("SELECT m.*,o.nominal_json,o.nominal_due_at FROM task_recurrence_members m JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE m.series_id=$1 AND o.nominal_due_at>clock_timestamp() ORDER BY o.nominal_due_at,o.id LIMIT 1")
      .bind(id).fetch_optional(&mut *tx).await.map_err(storage)?.map(map_member).transpose()?
  };
  let effective_after = if let Some(member) = boundary {
    member_in(tx, workspace, id, member).await?
  } else {
    None
  };
  let pending=sqlx::query("SELECT o.nominal_json,o.nominal_due_at FROM scheduling_occurrences o WHERE o.schedule_id=$1 AND o.generation=$2 AND o.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_recurrence_members m WHERE m.occurrence_id=o.id) ORDER BY o.nominal_due_at,o.id LIMIT 1")
    .bind(id).bind(schedule.generation).fetch_optional(&mut *tx).await.map_err(storage)?
    .map(|row|->RepoResult<Occurrence>{Ok(Occurrence{nominal:serde_json::from_value(row.try_get("nominal_json").map_err(storage)?).map_err(storage)?,due_at:row.try_get("nominal_due_at").map_err(storage)?})}).transpose()?;
  Ok(Some(TaskRecurrenceRead {
    series,
    schedule,
    paused_at,
    preserved_next,
    effective_after,
    pending,
    members,
  }))
}

pub(super) async fn read(pool: &PgPool, workspace: WorkspaceId, id: Uuid) -> RepoResult<Option<TaskRecurrenceRead>> {
  let mut tx = pool.begin().await.map_err(storage)?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    .execute(&mut *tx)
    .await
    .map_err(storage)?;
  read_visible_in(&mut tx, workspace, id, None).await
}

pub(super) async fn read_for_row(
  pool: &PgPool,
  workspace: WorkspaceId,
  row: DatabaseRowId,
) -> RepoResult<Option<TaskRecurrenceRead>> {
  let mut tx = pool.begin().await.map_err(storage)?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    .execute(&mut *tx)
    .await
    .map_err(storage)?;
  let association:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT s.id,m.id FROM task_recurrence_series s JOIN task_recurrence_members m ON m.series_id=s.id JOIN scheduling_schedules timing ON timing.id=s.id WHERE s.workspace_id=$1 AND m.row_id=$2 ORDER BY (timing.lifecycle<>'ended') DESC,s.created_at DESC,s.id DESC LIMIT 1")
    .bind(workspace).bind(row).fetch_optional(&mut *tx).await.map_err(storage)?;
  let Some((series, member)) = association else {
    return Ok(None);
  };
  read_visible_in(&mut tx, workspace, series, Some(member)).await
}

async fn read_visible_in(
  tx: &mut PgConnection,
  workspace: WorkspaceId,
  id: Uuid,
  requested: Option<Uuid>,
) -> RepoResult<Option<TaskRecurrenceRead>> {
  let mut view = read_in(tx, workspace, id).await?;
  if let (Some(view), Some(member)) = (&mut view, requested) {
    // A retained old/deleted member must remain manageable after it falls out
    // of recent history. Resolve it in this same read snapshot, never by a
    // client-side reconstruction of its occurrence identity.
    let member = member_in(tx, workspace, id, member).await?.ok_or_else(invalid)?;
    view.members.retain(|entry| entry.id != member.id);
    view.members.push(member);
  }
  // Membership-only projections do not include account disablement. Reuse the
  // same current-actor policy as admission, without granting reader authority
  // to act as that actor. This read transaction commits no product writes.
  if let Some(view) = &mut view
    && view.schedule.lifecycle != ScheduleLifecycle::Ended
  {
    let authority = if let Some(actor) = view.schedule.actor_id {
      crate::workflow_runtime::effects::lock_runtime_authority(tx, actor, workspace, false).await
    } else {
      Err(invalid())
    };
    if let Err(error) = authority {
      view.schedule.blocked_reason = Some(
        match error {
          RepositoryError::Storage(_) => "taskSourceUnavailable",
          _ => "taskPermissionUnavailable",
        }
        .into(),
      );
    }
  }
  Ok(view)
}

pub(super) async fn control(repo: &PgTaskRecurrenceRepository, command: TaskRecurrenceControl) -> RepoResult<()> {
  let mut tx = repo.pool.begin().await.map_err(storage)?;
  repo.databases.capture_managed_admission(&mut tx).await?;
  crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, command.actor_id, command.workspace_id, false)
    .await?;
  let locked = sqlx::query("SELECT id FROM scheduling_schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE NOWAIT")
    .bind(command.series_id)
    .bind(command.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?;
  if locked.is_none() {
    return Err(invalid());
  }
  let mut view = read_in(&mut tx, command.workspace_id, command.series_id)
    .await?
    .ok_or_else(invalid)?;
  if view.schedule.revision != command.expected_revision {
    return Err(conflict());
  }
  if view.schedule.lifecycle == ScheduleLifecycle::Ended {
    return Err(RepositoryError::Validation("ended Task recurrence is immutable".into()));
  }
  let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  let mut changed_actor = view.schedule.actor_id;
  let mut wake = None;
  let mut boundary = view.effective_after.as_ref().map(|member| member.id);
  let generation = view.schedule.generation.checked_add(1).ok_or_else(invalid)?;
  match command.change {
    TaskRecurrenceChange::Pause => {
      if view.schedule.lifecycle == ScheduleLifecycle::Paused {
        tx.commit().await.map_err(storage)?;
        return Ok(());
      }
      view.schedule.lifecycle = ScheduleLifecycle::Paused;
      view.paused_at = Some(now);
    }
    TaskRecurrenceChange::End => {
      view.schedule.lifecycle = ScheduleLifecycle::Ended;
      view.paused_at = None;
      view.schedule.next = None;
      view.schedule.next_admission_at = None;
      view.schedule.next_cause_member_id = None;
    }
    change => {
      let resume = matches!(change, TaskRecurrenceChange::Resume);
      if resume && view.schedule.lifecycle != ScheduleLifecycle::Paused {
        tx.commit().await.map_err(storage)?;
        return Ok(());
      }
      if let TaskRecurrenceChange::Update { rule, zone, recipe } = change {
        rule.validate(zone).map_err(storage)?;
        PgDatabaseRepository::lock_managed_admission(&mut tx, recipe.database_id).await?;
        let target:Option<Uuid>=sqlx::query_scalar("SELECT d.id FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL FOR SHARE OF d,p NOWAIT")
          .bind(recipe.database_id).bind(command.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?;
        if target.is_none() {
          return Err(invalid());
        }
        view.schedule.rule = Some(rule);
        view.schedule.zone = zone;
        view.series.recipe = recipe;
        changed_actor = Some(command.actor_id);
        boundary = view.preserved_next.as_ref().map(|member| member.id);
      }
      if resume {
        view.schedule.lifecycle = ScheduleLifecycle::Active;
        view.paused_at = None;
      }
      match view.schedule.rule.clone().ok_or_else(invalid)? {
        ScheduleRule::Fixed { rule } => {
          let boundary = view.preserved_next.as_ref().and_then(|member| member.slot);
          view.schedule.next =
            myoxus_application::recurrence::fixed_change_next(&rule, now, boundary).map_err(storage)?;
          view.schedule.next_admission_at = view
            .schedule
            .next
            .map(|_| boundary.map_or(now, |slot| slot.due_at.max(now)));
          view.schedule.next_cause_member_id = None;
          view.series.current_member_id = None;
        }
        ScheduleRule::AfterCompletion { interval, date_only } => {
          let current = if let Some(current) = view.series.current_member_id {
            member_in(&mut tx, command.workspace_id, command.series_id, current).await?
          } else {
            view
              .preserved_next
              .clone()
              .or_else(|| view.members.iter().find(|member| member.advanced_at.is_none()).cloned())
          };
          let current = current.ok_or_else(invalid)?;
          view.series.current_member_id = Some(current.id);
          view.schedule.next = None;
          view.schedule.next_admission_at = None;
          view.schedule.next_cause_member_id = None;
          if current.advanced_at.is_some() {
            let old_reference: Option<DateTime<Utc>> = sqlx::query_scalar(
              "SELECT successor_reference_at FROM task_recurrence_members WHERE id=$1 FOR UPDATE NOWAIT",
            )
            .bind(current.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(storage)?;
            let reference = if resume && current.successor_occurrence_id.is_none() {
              Some(now)
            } else {
              old_reference
            };
            if let Some(reference) = reference {
              let slot = super::advance::relative_slot(reference, interval, date_only, view.schedule.zone)?;
              let occurrence = task_occurrence_id(command.series_id, slot.nominal, Some(current.id));
              sqlx::query(
                "UPDATE task_recurrence_members SET successor_occurrence_id=$2,successor_reference_at=$3 WHERE id=$1",
              )
              .bind(current.id)
              .bind(occurrence)
              .bind(reference)
              .execute(&mut *tx)
              .await
              .map_err(storage)?;
              view.schedule.next = Some(slot);
              view.schedule.next_admission_at = Some(now);
              view.schedule.next_cause_member_id = Some(current.id);
              wake = Some(current.id);
            }
          }
        }
      }
    }
  }
  view.schedule.generation = generation;
  sqlx::query("UPDATE scheduling_schedules SET actor_id=$3,rule_json=$4,admission_zone=$5,lifecycle=$6,generation=$7,revision=revision+1,next_nominal=$8,next_due_at=$9,next_admission_at=$10,next_cause_member_id=$11,blocked_reason=NULL,paused_at=$12,updated_at=now() WHERE id=$1 AND workspace_id=$2")
    .bind(command.series_id).bind(command.workspace_id).bind(changed_actor)
    .bind(serde_json::to_value(&view.schedule.rule).map_err(storage)?).bind(String::from(view.schedule.zone))
    .bind(match view.schedule.lifecycle{ScheduleLifecycle::Active=>"active",ScheduleLifecycle::Paused=>"paused",ScheduleLifecycle::Ended=>"ended"})
    .bind(generation).bind(view.schedule.next.map(|slot|serde_json::to_value(slot.nominal)).transpose().map_err(storage)?)
    .bind(view.schedule.next.map(|slot|slot.due_at)).bind(view.schedule.next_admission_at).bind(view.schedule.next_cause_member_id)
    .bind(view.paused_at).execute(&mut *tx).await.map_err(storage)?;
  sqlx::query(
    "UPDATE task_recurrence_series SET recipe_json=$2,current_member_id=$3,effective_after_member_id=$4 WHERE id=$1",
  )
  .bind(command.series_id)
  .bind(serde_json::to_value(&view.series.recipe).map_err(storage)?)
  .bind(view.series.current_member_id)
  .bind(boundary)
  .execute(&mut *tx)
  .await
  .map_err(storage)?;
  if let Some(member) = wake {
    super::advance::wake_in(&mut tx, &view.schedule, member).await?;
  }
  tx.commit().await.map_err(storage)?;
  Ok(())
}

pub(super) async fn skip(
  repo: &PgTaskRecurrenceRepository,
  command: TaskRecurrenceSkip,
  target: Option<TaskRecurrenceSkipTarget>,
) -> RepoResult<TaskRecurrenceSkipOutcome> {
  let mut tx = repo.pool.begin().await.map_err(storage)?;
  repo.databases.capture_managed_admission(&mut tx).await?;
  crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, command.actor_id, command.workspace_id, false)
    .await?;
  // Replay needs only the original scoped receipt and current series control
  // authority. It never recreates or rewrites a moved/deleted acknowledged Task.
  let replay:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_recurrence_members m JOIN scheduling_schedules s ON s.id=m.series_id WHERE m.id=$1 AND m.series_id=$2 AND s.workspace_id=$3 AND s.lifecycle<>'ended' AND m.advanced_at IS NOT NULL)")
    .bind(command.member_id).bind(command.series_id).bind(command.workspace_id).fetch_one(&mut *tx).await.map_err(storage)?;
  if replay {
    return Ok(TaskRecurrenceSkipOutcome {
      changed_cell: None,
      accepted: false,
    });
  }
  let target = target.ok_or_else(invalid)?;
  crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, command.actor_id, target.workspace_id, false)
    .await?;
  crate::workspace_automation::PgWorkspaceAutomationRepository::lock_document_review_tasks(&mut tx, &[target.row_id])
    .await?;
  PgDatabaseRepository::lock_managed_admission(&mut tx, target.database_id).await?;
  PgDatabaseRepository::lock_project_definition_fields(&mut tx, target.database_id).await?;
  let rows = crate::workspace_database::DATABASE_ROWS_TABLE;
  let row=sqlx::query(&format!("SELECT edit_revision FROM {rows} WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR UPDATE"))
    .bind(target.row_id).bind(target.database_id).fetch_optional(&mut *tx).await.map_err(storage)?.ok_or_else(invalid)?;
  if row.try_get::<i64, _>("edit_revision").map_err(storage)? != command.expected_row_revision {
    return Err(RepositoryError::Conflict("database row edit revision"));
  }
  let plan = sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE NOWAIT")
    .bind(command.series_id)
    .bind(command.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(storage)?
    .ok_or_else(invalid)?;
  let plan = PgSchedulingRepository::map_plan(plan)?;
  let member = sqlx::query(
    "SELECT row_id,advanced_at FROM task_recurrence_members WHERE id=$1 AND series_id=$2 FOR UPDATE NOWAIT",
  )
  .bind(command.member_id)
  .bind(command.series_id)
  .fetch_optional(&mut *tx)
  .await
  .map_err(storage)?
  .ok_or_else(invalid)?;
  if member
    .try_get::<Option<DateTime<Utc>>, _>("advanced_at")
    .map_err(storage)?
    .is_some()
  {
    return Ok(TaskRecurrenceSkipOutcome {
      changed_cell: None,
      accepted: false,
    });
  }
  if member.try_get::<Uuid, _>("row_id").map_err(storage)? != target.row_id
    || plan.lifecycle == ScheduleLifecycle::Ended
  {
    return Err(invalid());
  }
  if plan.revision != command.expected_revision {
    return Err(conflict());
  }
  let fields = crate::workspace_database::DATABASE_FIELDS_TABLE;
  let config:Option<serde_json::Value>=sqlx::query_scalar(&format!("SELECT f.config_json FROM database_field_roles r JOIN {fields} f ON f.id=r.field_id AND f.database_id=r.database_id WHERE r.database_id=$1 AND r.field_id=$2 AND r.profile_kind='project' AND r.row_kind_scope='task' AND r.role_key='task.status' AND f.field_type='status' FOR SHARE OF r,f NOWAIT"))
    .bind(target.database_id).bind(target.status_field_id).fetch_optional(&mut *tx).await.map_err(storage)?;
  let config: DatabaseFieldConfig = serde_json::from_value(config.ok_or_else(invalid)?).map_err(storage)?;
  if !matches!(config,DatabaseFieldConfig::Status(config) if config.options.iter().any(|option|option.id==target.archived_option_id && option.group==DatabaseStatusGroup::Archived))
  {
    return Err(invalid());
  }
  let cell = repo
    .databases
    .update_cell_value_in_tx(
      &mut tx,
      target.row_id,
      target.status_field_id,
      DatabaseCellValueData::Status(target.archived_option_id),
      command.actor_id,
      DatabaseEditPrecondition::new(Some(command.expected_status_revision), false)
        .in_workspace(target.workspace_id)
        .in_database(target.database_id),
      None,
    )
    .await?;
  let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
  super::advance::advance_member_in(&mut tx, &plan, command.member_id, "skip", now).await?;
  sqlx::query("UPDATE scheduling_schedules SET revision=revision+1,updated_at=now() WHERE id=$1")
    .bind(command.series_id)
    .execute(&mut *tx)
    .await
    .map_err(storage)?;
  tx.commit().await.map_err(storage)?;
  Ok(TaskRecurrenceSkipOutcome {
    changed_cell: Some(cell),
    accepted: true,
  })
}
