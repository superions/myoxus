//! Auto-version trigger orchestration for document versioning.
//!
//! This service is shared by GraphQL mutations and worker jobs so trigger labels,
//! unchanged-document skips, logging, and repository error handling do not drift
//! between entry points.

use std::sync::Arc;

use thiserror::Error;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::{AutoVersionTrigger, DocumentVersion, DocumentVersionEvent, DocumentVersionKind};
use myoxus_domain::repositories::{DocumentVersionRepository, DocumentVersioningSettingsRepository, RepositoryError};

use crate::doc::DocService;
use crate::document_version::{DocumentVersionCreateError, DocumentVersionCreateRequest, DocumentVersionCreateService};

#[derive(Debug, Error)]
pub enum AutoVersionError {
  #[error(transparent)]
  Repository(#[from] RepositoryError),
  #[error(transparent)]
  Capture(#[from] DocumentVersionCreateError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoVersionSkipReason {
  VersioningDisabled,
  TriggerDisabled,
  Unchanged,
}

#[derive(Debug, Clone)]
pub enum AutoVersionOutcome {
  Created(Box<DocumentVersion>),
  Skipped(AutoVersionSkipReason),
}

#[derive(Debug, Clone)]
pub struct DocumentVersionAutoTriggerRequest {
  pub doc_id: Uuid,
  pub workspace_id: Uuid,
  pub actor_id: Uuid,
  pub trigger: AutoVersionTrigger,
  pub description: Option<String>,
  pub skip_unchanged: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAutoVersionSummary {
  pub targets: usize,
  pub created: usize,
  pub skipped_disabled: usize,
  pub skipped_trigger_disabled: usize,
  pub skipped_unchanged: usize,
  pub failed: usize,
}

#[derive(Clone)]
pub struct DocumentVersionAutoTriggerService {
  create_service: DocumentVersionCreateService,
  settings_repo: Arc<dyn DocumentVersioningSettingsRepository>,
}

impl DocumentVersionAutoTriggerService {
  pub fn new(
    doc_service: Arc<DocService>,
    version_repo: Arc<dyn DocumentVersionRepository>,
    settings_repo: Arc<dyn DocumentVersioningSettingsRepository>,
  ) -> Self {
    Self {
      create_service: DocumentVersionCreateService::new(doc_service, version_repo),
      settings_repo,
    }
  }

  #[instrument(skip(self, request), fields(doc_id = %request.doc_id, workspace_id = %request.workspace_id, trigger = ?request.trigger), level = "info")]
  pub async fn create_for_trigger(
    &self,
    request: DocumentVersionAutoTriggerRequest,
  ) -> Result<AutoVersionOutcome, AutoVersionError> {
    let DocumentVersionAutoTriggerRequest {
      doc_id,
      workspace_id,
      actor_id,
      trigger,
      description,
      skip_unchanged,
    } = request;
    let settings = self.settings_repo.get(doc_id).await?;
    if !settings.enabled {
      debug!(%doc_id, %workspace_id, ?trigger, "document auto-version skipped: versioning disabled");
      return Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::VersioningDisabled));
    }
    if !settings.auto_version_on.iter().any(|configured| configured == &trigger) {
      debug!(%doc_id, %workspace_id, ?trigger, "document auto-version skipped: trigger disabled");
      return Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::TriggerDisabled));
    }

    let event = match trigger {
      AutoVersionTrigger::OnPublish => DocumentVersionEvent::Publish,
      AutoVersionTrigger::OnPdfExport => DocumentVersionEvent::PdfExport,
      AutoVersionTrigger::Daily => DocumentVersionEvent::Daily,
    };
    let version = self
      .create_service
      .capture(
        DocumentVersionCreateRequest {
          doc_id,
          workspace_id,
          actor_id,
          requested_label: None,
          description,
          event,
          kind: match trigger {
            AutoVersionTrigger::OnPublish => DocumentVersionKind::Published,
            AutoVersionTrigger::OnPdfExport => DocumentVersionKind::Exported,
            AutoVersionTrigger::Daily => DocumentVersionKind::Checkpoint,
          },
        },
        skip_unchanged,
      )
      .await?;
    let Some(version) = version else {
      info!(%doc_id, %workspace_id, ?trigger, "document auto-version skipped: content unchanged");
      return Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::Unchanged));
    };
    info!(
      %doc_id,
      %workspace_id,
      %actor_id,
      ?trigger,
      version_id = %version.id,
      history_id = version.doc_history_id,
      label = %version.label,
      "document auto-version created"
    );
    Ok(AutoVersionOutcome::Created(Box::new(version)))
  }

  #[instrument(skip(self), level = "info")]
  pub async fn run_daily(&self) -> Result<DailyAutoVersionSummary, AutoVersionError> {
    let targets = self
      .settings_repo
      .list_enabled_for_trigger(AutoVersionTrigger::Daily)
      .await?;
    let mut summary = DailyAutoVersionSummary {
      targets: targets.len(),
      ..DailyAutoVersionSummary::default()
    };

    for target in targets {
      match self
        .create_for_trigger(DocumentVersionAutoTriggerRequest {
          doc_id: target.doc_id,
          workspace_id: target.workspace_id,
          actor_id: target.actor_id,
          trigger: AutoVersionTrigger::Daily,
          description: Some("Automatically created by the daily document versioning trigger".to_string()),
          skip_unchanged: true,
        })
        .await
      {
        Ok(AutoVersionOutcome::Created(_)) => summary.created += 1,
        Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::VersioningDisabled)) => summary.skipped_disabled += 1,
        Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::TriggerDisabled)) => {
          summary.skipped_trigger_disabled += 1;
        }
        Ok(AutoVersionOutcome::Skipped(AutoVersionSkipReason::Unchanged)) => summary.skipped_unchanged += 1,
        Err(err) => {
          summary.failed += 1;
          warn!(
            doc_id = %target.doc_id,
            workspace_id = %target.workspace_id,
            error = %err,
            "daily document auto-version failed for target"
          );
        }
      }
    }

    info!(
      targets = summary.targets,
      created = summary.created,
      skipped_disabled = summary.skipped_disabled,
      skipped_trigger_disabled = summary.skipped_trigger_disabled,
      skipped_unchanged = summary.skipped_unchanged,
      failed = summary.failed,
      "daily document auto-version run finished"
    );
    Ok(summary)
  }
}
