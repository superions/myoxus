// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only preparation of a closed document Review destination. Persistence
//! rechecks these facts before committing the slot, native Run and first snapshot.
use super::*;
use chrono::SubsecRound;
use myoxus_domain::workspace_automation::AcceptedAutomationRun;

#[async_trait]
pub trait ScheduledDocumentReviewSource: Send + Sync {
  async fn prepare_document_review(
    &self,
    plan: &ScheduledPlan,
    now: DateTime<Utc>,
  ) -> Result<AcceptedAutomationRun, &'static str>;
}

#[async_trait]
impl ScheduledDocumentReviewSource for DocumentMetadataService {
  #[instrument(skip_all,fields(schedule_id=%plan.id))]
  async fn prepare_document_review(
    &self,
    plan: &ScheduledPlan,
    now: DateTime<Utc>,
  ) -> Result<AcceptedAutomationRun, &'static str> {
    let ScheduleTarget::DocumentReview {
      document_id,
      enabled: true,
      confirmed_by,
      package,
      locale,
      effective_deadline: Some(deadline),
    } = &plan.target
    else {
      return Err("reviewTargetUnavailable");
    };
    if plan.actor_id != Some(*confirmed_by) || plan.lifecycle != myoxus_domain::scheduling::ScheduleLifecycle::Active {
      return Err("reviewConsentUnavailable");
    }
    let capabilities = self.reviews.as_ref().ok_or("formalReviewUnavailable")?;
    let current = capabilities
      .repo
      .read_review_planning(*document_id, plan.workspace_id)
      .await
      .map_err(|_| "reviewMetadataUnavailable")?;
    if !current.metadata.available || current.metadata.deadline() != Some(*deadline) {
      return Err("reviewMetadataChanged");
    }
    let Some(actual) = current.schedule.as_ref() else {
      return Err("reviewConsentUnavailable");
    };
    if actual.generation != plan.generation || actual.revision != plan.revision || actual.target != plan.target {
      return Err("reviewConsentChanged");
    }
    if current.previous_pending && !current.cycle_accepted {
      return Err("previousReviewPending");
    }
    let reviewer = current.metadata.responsible_id.ok_or("missingResponsible")?;
    // PostgreSQL/engine comparison uses microseconds. Keep the source instant,
    // but freeze an expired source's separate future process deadline once.
    let process = if *deadline > now {
      *deadline
    } else {
      now
        .checked_add_signed(Duration::days(LEAD_DAYS))
        .ok_or("reviewDeadlineOutOfRange")?
        .trunc_subsecs(6)
    };
    let mut prepared = capabilities
      .automations
      .prepare_metadata_document_review(
        *confirmed_by,
        plan.workspace_id,
        *document_id,
        reviewer,
        process,
        &String::from(plan.zone),
        locale,
        package,
      )
      .await?;
    if !prepared.execution_available {
      return Err("formalReviewUnavailable");
    }
    prepared.source_metadata_deadline = Some(*deadline);
    capabilities
      .automations
      .accepted_scheduled_document_review(prepared, plan.id, plan.generation)
      .map_err(|_| "reviewDefinitionUnavailable")
  }
}
