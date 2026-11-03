// SPDX-License-Identifier: AGPL-3.0-or-later
//! One absolute document deadline owns one durable native Review receipt.
use super::*;
use crate::workspace_automation::PgWorkspaceAutomationRepository;

async fn pending_in(conn: &mut PgConnection, schedule: Uuid) -> RepoResult<bool> {
  sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduling_occurrences o JOIN workspace_automation_runs r ON r.id=o.run_id WHERE o.schedule_id=$1 AND r.origin_kind='document_review' AND r.review_outcome_json IS NULL AND r.review_invalid_reason IS NULL AND r.review_expired_at IS NULL AND r.status<>'skipped')")
    .bind(schedule).fetch_one(conn).await.map_err(storage)
}

/// Formal decisions use the native Task writer's authority. Its locked editor
/// floor also retains source-read access; a read-only responsible stays blocked.
async fn lock_reviewer(conn: &mut PgConnection, reviewer: Uuid, workspace: Uuid) -> RepoResult<()> {
  let member:Option<Uuid>=sqlx::query_scalar("SELECT u.id FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.workspace_id=$2 AND m.status='Accepted' AND u.status='active' FOR SHARE OF m,u NOWAIT")
    .bind(reviewer).bind(workspace).fetch_optional(&mut *conn).await.map_err(storage)?;
  if member.is_none() {
    return Err(blocked("reviewerUnavailable"));
  }
  crate::workflow_runtime::effects::lock_runtime_authority(conn, reviewer, workspace, false)
    .await
    .map_err(|_| blocked("reviewerDecisionUnavailable"))?;
  Ok(())
}

impl PgSchedulingRepository {
  #[tracing::instrument(skip_all,fields(schedule_id=%plan.id))]
  pub(super) async fn admit_document_review(
    &self,
    plan: &ScheduledPlan,
    now: DateTime<Utc>,
  ) -> RepoResult<Option<usize>> {
    let source = self
      .review_source
      .as_ref()
      .ok_or_else(|| blocked("formalReviewUnavailable"))?;
    let accepted = source.prepare_document_review(plan, now).await.map_err(blocked)?;
    let review = accepted
      .document_review
      .as_ref()
      .ok_or_else(|| blocked("reviewPreparedInputMismatch"))?;
    let deadline = review
      .plan
      .source_metadata_deadline
      .ok_or_else(|| blocked("reviewPreparedInputMismatch"))?;
    let document = review.plan.source_document_id;
    let actor = plan.actor_id.ok_or_else(|| blocked("reviewActorUnavailable"))?;
    let ScheduleTarget::DocumentReview {
      document_id,
      enabled: true,
      confirmed_by,
      package,
      locale,
      effective_deadline: Some(expected_deadline),
    } = &plan.target
    else {
      return Err(blocked("reviewPreparedInputMismatch"));
    };
    if *document_id != document
      || *confirmed_by != actor
      || *expected_deadline != deadline
      || review.plan.package != *package
      || review.plan.locale != *locale
      || review.plan.deadline_time_zone != String::from(plan.zone)
    {
      return Err(blocked("reviewPreparedInputMismatch"));
    }
    let occurrence = document_review_occurrence_id(document, deadline);
    let nominal = ScheduleValue::LocalDateTime(deadline.naive_utc());
    if document_review_schedule_id(document) != plan.id
      || accepted.workspace_id != plan.workspace_id
      || accepted.actor_id != Some(actor)
      || review.plan.actor_id != actor
      || accepted.run_id != Uuid::new_v5(&occurrence, b"run")
      || review.request_id != occurrence
      || review.scheduling_generation != Some(plan.generation)
      || review.review_task_id != Uuid::new_v5(&occurrence, b"review-task")
      || review.follow_up_task_id != Uuid::new_v5(&occurrence, b"follow-up-task")
      || plan
        .next
        .is_none_or(|next| next.due_at != deadline || next.nominal != nominal)
    {
      return Err(blocked("reviewPreparedInputMismatch"));
    }
    self
      .runtime
      .register_definition(accepted.definition.clone())
      .await
      .map_err(|_| blocked("formalReviewUnavailable"))?;
    let mut tx = self.pool.begin().await.map_err(storage)?;
    // Native actor authority supplies the Doc editor floor and is locked before
    // any native Run/document/timing lock, matching existing capture admission.
    crate::workflow_runtime::effects::lock_runtime_authority(&mut tx, actor, plan.workspace_id, false).await?;
    let clock: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
    let previous=sqlx::query("SELECT r.id,r.review_deadline_at FROM scheduling_occurrences o JOIN workspace_automation_runs r ON r.id=o.run_id WHERE o.schedule_id=$1 AND r.origin_kind='document_review' AND r.review_outcome_json IS NULL AND r.review_invalid_reason IS NULL AND r.review_expired_at IS NULL AND r.status<>'skipped' ORDER BY r.id LIMIT 2 FOR UPDATE OF r NOWAIT")
      .bind(plan.id).fetch_all(&mut *tx).await.map_err(storage)?;
    if previous.len() > 1 {
      return Err(blocked("reviewPendingIntegrity"));
    }
    for previous in previous {
      let previous_deadline: DateTime<Utc> = previous.try_get("review_deadline_at").map_err(storage)?;
      if previous_deadline > clock {
        return Err(blocked("previousReviewPending"));
      }
      PgWorkspaceAutomationRepository::expire_document_review_in(
        &mut tx,
        previous.try_get("id").map_err(storage)?,
        clock,
      )
      .await?;
    }
    // Native Task writers lock their destination before the source document.
    // Freeze current readiness as well: a deleted/unready container is an
    // unconsumed prerequisite failure, not an accepted execution failure.
    let destination:Option<serde_json::Value>=sqlx::query_scalar("SELECT d.managed_installation FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project' WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL FOR SHARE OF d,p NOWAIT")
      .bind(review.plan.destination_database_id).bind(plan.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?.flatten();
    let destination: myoxus_domain::database::DatabaseManagedSchemaInstallation =
      serde_json::from_value(destination.ok_or_else(|| blocked("reviewDestinationUnavailable"))?)
        .map_err(|_| blocked("reviewDestinationUnavailable"))?;
    if destination.readiness != myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready {
      return Err(blocked("reviewDestinationUnavailable"));
    }
    let revision = crate::doc::SqlxDocStore::review_source_revision_in_tx(
      &mut tx,
      plan.workspace_id,
      document,
      &review.plan.source_external_id,
    )
    .await
    .map_err(|_| blocked("reviewSourceUnavailable"))?;
    if revision != review.plan.source_revision {
      return Err(blocked("reviewSourceChanged"));
    }
    let present:Option<Uuid>=sqlx::query_scalar("SELECT id FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root FOR UPDATE NOWAIT")
      .bind(document).bind(plan.workspace_id).fetch_optional(&mut *tx).await.map_err(storage)?;
    if present.is_none() {
      return Err(blocked("reviewSourceUnavailable"));
    }
    let metadata = crate::document_metadata::review::metadata_in(&mut tx, document, plan.workspace_id).await?;
    if metadata.deadline() != Some(deadline) || metadata.responsible_id != Some(review.plan.reviewer_id) {
      return Err(blocked("reviewMetadataChanged"));
    }
    lock_reviewer(&mut tx, review.plan.reviewer_id, plan.workspace_id).await?;
    let current=sqlx::query("SELECT * FROM scheduling_schedules WHERE id=$1 AND generation=$2 AND revision=$3 AND lifecycle='active' AND next_admission_at<=$4 FOR UPDATE NOWAIT")
      .bind(plan.id).bind(plan.generation).bind(plan.revision).bind(now).fetch_optional(&mut *tx).await.map_err(storage)?;
    let Some(current) = current else { return Ok(None) };
    let current = Self::map_plan(current)?;
    if current.target != plan.target
      || current.actor_id != plan.actor_id
      || current.zone != plan.zone
      || current.workspace_id != plan.workspace_id
      || current.next != plan.next
    {
      return Ok(None);
    }
    // A contender may have committed a new prior Run before our document lock.
    // Do not invert native Run→document ordering by waiting for it here.
    if pending_in(&mut tx, plan.id).await? {
      return Err(blocked("previousReviewPending"));
    }
    let existing: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM scheduling_occurrences WHERE schedule_id=$1 AND nominal_due_at=$2)",
    )
    .bind(plan.id)
    .bind(deadline)
    .fetch_one(&mut *tx)
    .await
    .map_err(storage)?;
    if existing {
      sqlx::query("UPDATE scheduling_schedules SET next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,blocked_reason='cycleAlreadyAccepted',updated_at=clock_timestamp() WHERE id=$1").bind(plan.id).execute(&mut *tx).await.map_err(storage)?;
      tx.commit().await.map_err(storage)?;
      return Ok(Some(0));
    }
    let inserted=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
      .bind(occurrence).bind(plan.id).bind(serde_json::to_value(nominal).map_err(storage)?).bind(deadline).bind(plan.generation).bind(Uuid::new_v5(&occurrence,b"dispatch")).execute(&mut *tx).await.map_err(storage)?;
    if inserted.rows_affected() != 1 {
      return Err(blocked("reviewCycleConflict"));
    }
    let run = self
      .runtime
      .accept_document_review_in(&mut tx, &accepted)
      .await
      .map_err(|_| blocked("reviewAdmissionUnavailable"))?;
    if run.id != accepted.run_id || run.idempotency_key != review.fingerprint {
      return Err(blocked("reviewCycleConflict"));
    }
    sqlx::query("UPDATE scheduling_occurrences SET run_id=$2 WHERE id=$1")
      .bind(occurrence)
      .bind(run.id)
      .execute(&mut *tx)
      .await
      .map_err(storage)?;
    sqlx::query("UPDATE scheduling_schedules SET next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,blocked_reason='cycleAlreadyAccepted',updated_at=clock_timestamp() WHERE id=$1").bind(plan.id).execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(Some(1))
  }
}
