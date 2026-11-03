// SPDX-License-Identifier: AGPL-3.0-or-later
//! Metadata and standing consent share the document lock before timing locks.
use super::*;
use myoxus_application::document_metadata::review::{
  DocumentReviewPlanningRepository, LEAD_DAYS, ReviewMetadata, ReviewPlanningState,
};
use myoxus_domain::scheduling::{AdmissionZone, ScheduleTarget, ScheduleValue};

fn codec_error(_: serde_json::Error) -> RepositoryError {
  RepositoryError::Storage("document Review timing codec unavailable".into())
}

fn schedule_id(document: Uuid) -> Uuid {
  myoxus_domain::scheduling::document_review_schedule_id(document)
}

pub(crate) async fn metadata_in(
  conn: &mut PgConnection,
  document: Uuid,
  workspace: Uuid,
) -> RepoResult<ReviewMetadata> {
  let row=sqlx::query("SELECT id,workspace_id,metadata_revision,responsible_user_id,review_due_at,valid_until,(deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root) available FROM docs WHERE id=$1 AND workspace_id=$2")
    .bind(document).bind(workspace).fetch_optional(conn).await.map_err(db_error)?.ok_or(RepositoryError::NotFound("document metadata"))?;
  Ok(ReviewMetadata {
    document_id: row.get("id"),
    workspace_id: row.get("workspace_id"),
    revision: row.get("metadata_revision"),
    responsible_id: row.get("responsible_user_id"),
    review_due_at: row.get("review_due_at"),
    valid_until: row.get("valid_until"),
    available: row.get("available"),
  })
}

/// Recompute only the canonical timing input. Unrelated metadata never calls it;
/// a responsible-only repair cannot replay a consumed source-deadline cycle.
pub(super) async fn rearm_in(conn: &mut PgConnection, document: Uuid, workspace: Uuid) -> RepoResult<()> {
  let metadata = metadata_in(conn, document, workspace).await?;
  let Some(row) =
    sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND target_json->>'kind'='document_review' FOR UPDATE")
      .bind(schedule_id(document))
      .fetch_optional(&mut *conn)
      .await
      .map_err(db_error)?
  else {
    return Ok(());
  };
  let mut plan = crate::scheduling::PgSchedulingRepository::map_plan(row)?;
  let ScheduleTarget::DocumentReview {
    document_id,
    enabled,
    effective_deadline,
    ..
  } = &mut plan.target
  else {
    return Err(RepositoryError::Validation(
      "document Review timing target mismatch".into(),
    ));
  };
  if *document_id != document {
    return Err(RepositoryError::Validation(
      "document Review timing identity mismatch".into(),
    ));
  }
  let deadline = metadata.deadline();
  let changed = *effective_deadline != deadline;
  *effective_deadline = deadline;
  let consumed = if let Some(deadline) = deadline {
    sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE schedule_id=$1 AND nominal_due_at=$2)",
    )
    .bind(plan.id)
    .bind(deadline)
    .fetch_one(&mut *conn)
    .await
    .map_err(db_error)?
  } else {
    false
  };
  let blocked = if !*enabled {
    Some("notEnabled")
  } else if !metadata.available {
    Some("documentUnavailable")
  } else if deadline.is_none() {
    Some("missingDeadline")
  } else if consumed {
    Some("cycleAlreadyAccepted")
  } else if metadata.responsible_id.is_none() {
    Some("missingResponsible")
  } else {
    None
  };
  let due = deadline.filter(|_| *enabled && metadata.available && !consumed);
  let nominal = due
    // Metadata deadlines are instants. A civil label alone would collapse two
    // distinct deadlines in a fall-back fold into one shared slot identity.
    .map(|due| ScheduleValue::LocalDateTime(due.naive_utc()))
    .map(serde_json::to_value)
    .transpose()
    .map_err(codec_error)?;
  let admission = due
    .map(|due| {
      due
        .checked_sub_signed(chrono::Duration::days(LEAD_DAYS))
        .ok_or_else(|| RepositoryError::Validation("document Review deadline outside supported range".into()))
    })
    .transpose()?;
  sqlx::query("UPDATE scheduling_schedules SET target_json=$2,next_nominal=$3,next_due_at=$4,next_admission_at=$5,blocked_reason=$6,generation=generation+CASE WHEN $7 THEN 1 ELSE 0 END,revision=revision+CASE WHEN $7 THEN 1 ELSE 0 END,updated_at=clock_timestamp() WHERE id=$1")
    .bind(plan.id).bind(serde_json::to_value(&plan.target).map_err(codec_error)?).bind(nominal).bind(due).bind(admission).bind(blocked).bind(changed).execute(conn).await.map_err(db_error)?;
  Ok(())
}

#[async_trait]
impl DocumentReviewPlanningRepository for PgDocumentMetadataRepository {
  #[instrument(skip_all)]
  async fn read_review_planning(&self, document: Uuid, workspace: Uuid) -> RepoResult<ReviewPlanningState> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(db_error)?;
    let metadata = metadata_in(&mut tx, document, workspace).await?;
    let schedule = sqlx::query(
      "SELECT * FROM scheduling_schedules WHERE id=$1 AND workspace_id=$2 AND target_json->>'kind'='document_review'",
    )
    .bind(schedule_id(document))
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?
    .map(crate::scheduling::PgSchedulingRepository::map_plan)
    .transpose()?;
    let receipt=sqlx::query("SELECT o.run_id,o.nominal_due_at,r.review_deadline_at FROM scheduling_occurrences o LEFT JOIN workspace_automation_runs r ON r.id=o.run_id WHERE o.schedule_id=$1 ORDER BY (o.nominal_due_at=$2) DESC NULLS LAST,o.admitted_at DESC,o.id DESC LIMIT 1").bind(schedule_id(document)).bind(metadata.deadline()).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let cycle_accepted = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE schedule_id=$1 AND nominal_due_at=$2)",
    )
    .bind(schedule_id(document))
    .bind(metadata.deadline())
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let previous_pending=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences o JOIN workspace_automation_runs r ON r.id=o.run_id WHERE o.schedule_id=$1 AND r.origin_kind='document_review' AND r.review_outcome_json IS NULL AND r.review_invalid_reason IS NULL AND r.review_expired_at IS NULL AND r.status<>'skipped' AND r.review_deadline_at>clock_timestamp())").bind(schedule_id(document)).fetch_one(&mut *tx).await.map_err(db_error)?;
    let (run_id, accepted_source_deadline, accepted_process_deadline) = receipt
      .map(|row| {
        (
          row.get::<Option<Uuid>, _>("run_id"),
          Some(row.get::<chrono::DateTime<chrono::Utc>, _>("nominal_due_at")),
          row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_deadline_at"),
        )
      })
      .unwrap_or_default();
    tx.commit().await.map_err(db_error)?;
    Ok(ReviewPlanningState {
      metadata,
      schedule,
      run_id,
      cycle_accepted,
      previous_pending,
      accepted_source_deadline,
      accepted_process_deadline,
    })
  }

  #[instrument(skip_all)]
  async fn configure_review_planning(
    &self,
    document: Uuid,
    workspace: Uuid,
    actor: Uuid,
    expected_revision: i64,
    target: Option<ScheduleTarget>,
    zone: AdmissionZone,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(db_error)?;
    if target.is_some() {
      crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, workspace, false).await?;
    }
    let revision:Option<i64>=sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root FOR UPDATE").bind(document).bind(workspace).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let revision = revision.ok_or(RepositoryError::NotFound("document metadata"))?;
    if revision != expected_revision {
      return Err(RepositoryError::Conflict("document metadata revision conflict"));
    }
    reject_guide_content_write(&mut tx, document)
      .await
      .map_err(|_| RepositoryError::Validation("document metadata is read-only".into()))?;
    let existing = sqlx::query("SELECT target_json FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
      .bind(schedule_id(document))
      .fetch_optional(&mut *tx)
      .await
      .map_err(db_error)?;
    let previous = existing
      .as_ref()
      .map(|row| serde_json::from_value::<ScheduleTarget>(row.get("target_json")))
      .transpose()
      .map_err(codec_error)?;
    let enabled = matches!(previous, Some(ScheduleTarget::DocumentReview { enabled: true, .. }));
    if enabled == target.is_some() {
      tx.commit().await.map_err(db_error)?;
      return Ok(());
    }
    if let Some(target) = target {
      if !matches!(&target,ScheduleTarget::DocumentReview{document_id,confirmed_by,enabled:true,..} if *document_id==document&&*confirmed_by==actor)
      {
        return Err(RepositoryError::Validation("document Review consent mismatch".into()));
      }
      sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,target_json=EXCLUDED.target_json,lifecycle='active',generation=scheduling_schedules.generation+1,revision=scheduling_schedules.revision+1")
        .bind(schedule_id(document)).bind(workspace).bind(actor).bind(String::from(zone)).bind(serde_json::to_value(target).map_err(codec_error)?).execute(&mut *tx).await.map_err(db_error)?;
    } else {
      sqlx::query("UPDATE scheduling_schedules SET target_json=jsonb_set(target_json,'{enabled}','false'),lifecycle='ended',next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,blocked_reason='notEnabled',generation=generation+1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1")
        .bind(schedule_id(document)).execute(&mut *tx).await.map_err(db_error)?;
    }
    rearm_in(&mut tx, document, workspace).await?;
    sqlx::query("UPDATE docs SET metadata_revision=metadata_revision+1,metadata_updated_at=clock_timestamp(),metadata_updated_by=$2 WHERE id=$1").bind(document).bind(actor).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
  }
}
