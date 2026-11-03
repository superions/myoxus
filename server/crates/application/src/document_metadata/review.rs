// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit document consent and readiness over canonical metadata. This owns
//! planning only; native Review acceptance, decisions and effects keep their owner.

use super::*;
use crate::auth::{AuthService, UserPreferenceDefaults};
use crate::workspace::assistant_packages::AssistantPackageService;
use crate::workspace_automation::WorkspaceAutomationService;
use async_trait::async_trait;
use chrono::Duration;
use myoxus_domain::assistant_package::AssistantPackageContext;
use myoxus_domain::scheduling::{AdmissionZone, ScheduleTarget, ScheduledPlan};

pub mod admission;

pub const LEAD_DAYS: i64 = 14;

#[derive(Debug, Clone)]
pub struct ReviewMetadata {
  pub document_id: Uuid,
  pub workspace_id: Uuid,
  pub revision: i64,
  pub responsible_id: Option<Uuid>,
  pub review_due_at: Option<DateTime<Utc>>,
  pub valid_until: Option<DateTime<Utc>>,
  pub available: bool,
}
impl ReviewMetadata {
  /// Timestamp metadata is already canonical/materialized; legacy principal JSON
  /// and validity-start do not participate in the admission deadline.
  pub fn deadline(&self) -> Option<DateTime<Utc>> {
    self.review_due_at.into_iter().chain(self.valid_until).min()
  }
}

#[derive(Debug, Clone)]
pub struct ReviewPlanningState {
  pub metadata: ReviewMetadata,
  pub schedule: Option<ScheduledPlan>,
  pub run_id: Option<Uuid>,
  pub cycle_accepted: bool,
  pub previous_pending: bool,
  pub accepted_source_deadline: Option<DateTime<Utc>>,
  pub accepted_process_deadline: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ReviewPlanningView {
  pub enabled: bool,
  pub metadata_revision: i64,
  pub responsible_id: Option<Uuid>,
  pub source_deadline: Option<DateTime<Utc>>,
  pub next_start: Option<DateTime<Utc>>,
  pub process_deadline: Option<DateTime<Utc>>,
  pub zone: String,
  pub ready: bool,
  pub blocked_reason: Option<String>,
  pub run_id: Option<Uuid>,
}

#[async_trait]
pub trait DocumentReviewPlanningRepository: Send + Sync {
  async fn read_review_planning(&self, document: Uuid, workspace: Uuid)
  -> Result<ReviewPlanningState, RepositoryError>;
  /// Lock native metadata before the timing row. Consent and its revision fence
  /// commit together; repeated same-state confirmation must not rearm a cycle.
  async fn configure_review_planning(
    &self,
    document: Uuid,
    workspace: Uuid,
    actor: Uuid,
    expected_revision: i64,
    target: Option<ScheduleTarget>,
    zone: AdmissionZone,
  ) -> Result<(), RepositoryError>;
}

#[derive(Clone)]
pub struct ReviewPlanningCapabilities {
  pub repo: Arc<dyn DocumentReviewPlanningRepository>,
  pub packages: Arc<AssistantPackageService>,
  pub automations: Arc<WorkspaceAutomationService>,
  pub auth: Arc<AuthService>,
  pub defaults: UserPreferenceDefaults,
}

impl DocumentMetadataService {
  pub fn with_review_planning(mut self, capabilities: ReviewPlanningCapabilities) -> Self {
    self.reviews = Some(Arc::new(capabilities));
    self
  }

  #[instrument(skip_all,fields(%document,%workspace))]
  pub async fn review_planning(
    &self,
    document: Uuid,
    workspace: Uuid,
  ) -> Result<ReviewPlanningView, DocumentMetadataServiceError> {
    let capabilities = self
      .reviews
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("document Review planning unavailable".into()))?;
    let state = capabilities.repo.read_review_planning(document, workspace).await?;
    let (enabled, actor, package, locale, zone) = match state.schedule.as_ref() {
      Some(plan) => match &plan.target {
        ScheduleTarget::DocumentReview {
          enabled,
          confirmed_by,
          package,
          locale,
          ..
        } => (
          *enabled,
          Some(*confirmed_by),
          Some(package),
          locale.as_str(),
          String::from(plan.zone),
        ),
        _ => return Err(RepositoryError::Validation("document Review target mismatch".into()).into()),
      },
      None => (
        false,
        None,
        None,
        capabilities.packages.default_locale(),
        capabilities.defaults.timezone.clone(),
      ),
    };
    let deadline = state.metadata.deadline();
    let now = Utc::now();
    let overdue = deadline.is_some_and(|deadline| deadline <= now);
    let process_deadline = deadline.and_then(|deadline| {
      if state.cycle_accepted {
        return (state.accepted_source_deadline == Some(deadline))
          .then_some(state.accepted_process_deadline)
          .flatten()
          .filter(|process| *process != deadline);
      }
      if overdue {
        now.checked_add_signed(Duration::days(LEAD_DAYS))
      } else {
        Some(deadline)
      }
    });
    let mut blocked = if !enabled {
      Some("notEnabled")
    } else if !state.metadata.available {
      Some("documentUnavailable")
    } else if deadline.is_none() {
      Some("missingDeadline")
    } else if state.metadata.responsible_id.is_none() {
      Some("missingResponsible")
    } else if state.cycle_accepted {
      Some("cycleAlreadyAccepted")
    } else if state.previous_pending {
      Some("previousReviewPending")
    } else {
      None
    };
    if blocked.is_none() {
      if let (Some(actor), Some(package), Some(reviewer), Some(process)) =
        (actor, package, state.metadata.responsible_id, process_deadline)
      {
        match capabilities
          .automations
          .prepare_metadata_document_review(actor, workspace, document, reviewer, process, &zone, locale, package)
          .await
        {
          Ok(plan) if plan.execution_available => {}
          Ok(_) => blocked = Some("formalReviewUnavailable"),
          Err(reason) => blocked = Some(reason),
        }
      } else {
        blocked = Some("notEnabled")
      }
    }
    let next_start = if (blocked.is_none() || blocked == Some("notEnabled"))
      && state.metadata.available
      && state.metadata.responsible_id.is_some()
    {
      if enabled {
        state
          .schedule
          .as_ref()
          .and_then(|schedule| schedule.next_admission_at)
          .map(|start| start.max(now))
      } else {
        deadline
          .and_then(|deadline| deadline.checked_sub_signed(Duration::days(LEAD_DAYS)))
          .map(|start| start.max(now))
      }
    } else {
      None
    };
    Ok(ReviewPlanningView {
      enabled,
      metadata_revision: state.metadata.revision,
      responsible_id: state.metadata.responsible_id,
      source_deadline: deadline,
      next_start,
      process_deadline: if state.cycle_accepted {
        process_deadline
      } else {
        overdue.then_some(process_deadline).flatten()
      },
      zone,
      ready: enabled && blocked.is_none(),
      blocked_reason: blocked.map(str::to_owned),
      run_id: state.run_id,
    })
  }

  #[instrument(skip_all,fields(%document,%workspace,%actor,enabled))]
  pub async fn configure_review_planning(
    &self,
    document: Uuid,
    workspace: Uuid,
    actor: Uuid,
    expected_revision: i64,
    enabled: bool,
  ) -> Result<ReviewPlanningView, DocumentMetadataServiceError> {
    let capabilities = self
      .reviews
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("document Review planning unavailable".into()))?;
    let preferences = capabilities
      .auth
      .get_user_preferences(actor)
      .await
      .map_err(|_| RepositoryError::Validation("document Review actor unavailable".into()))?
      .values
      .resolve(&capabilities.defaults);
    let zone = AdmissionZone::try_from(preferences.timezone)
      .map_err(|_| RepositoryError::Validation("document Review zone unavailable".into()))?;
    let target = if enabled {
      capabilities
        .automations
        .assert_metadata_review_authority(actor, workspace, document)
        .await
        .map_err(|_| RepositoryError::Validation("document Review start authority unavailable".into()))?;
      capabilities
        .packages
        .metadata_review_target(actor, workspace)
        .await
        .map_err(|_| RepositoryError::Validation("document Review start authority unavailable".into()))?;
      let package = capabilities
        .packages
        .list(AssistantPackageContext::TaskContainerAssistance)
        .into_iter()
        .find(|descriptor| descriptor.identity.id == "myoxus.assistant.document-review")
        .map(|descriptor| descriptor.identity)
        .ok_or_else(|| RepositoryError::Validation("formal Review source unavailable".into()))?;
      Some(ScheduleTarget::DocumentReview {
        document_id: document,
        enabled: true,
        confirmed_by: actor,
        package,
        locale: capabilities.packages.default_locale().into(),
        effective_deadline: None,
      })
    } else {
      None
    };
    capabilities
      .repo
      .configure_review_planning(document, workspace, actor, expected_revision, target, zone)
      .await?;
    self.review_planning(document, workspace).await
  }
}
