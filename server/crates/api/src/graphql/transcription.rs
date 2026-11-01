// SPDX-License-Identifier: AGPL-3.0-or-later
//! Sanitized, live speech capability under the existing server configuration.

use super::auth::ServerConfigType;
use crate::state::ApiState;
use async_graphql::{ComplexObject, Context, Enum, Result, SimpleObject};
use myoxus_application::transcription::{TranscriptionConnectionOutcome, TranscriptionService};
use std::sync::Arc;

#[derive(Enum, Clone, Copy, PartialEq, Eq)]
#[graphql(rename_items = "PascalCase")]
pub enum TranscriptionAvailability {
  Disabled,
  Unconfigured,
  NotChecked,
  Available,
  Unavailable,
}

#[derive(SimpleObject)]
pub struct TranscriptionCapabilityType {
  pub enabled: bool,
  pub configured: bool,
  pub status: TranscriptionAvailability,
  pub max_input_bytes: u64,
  pub max_duration_seconds: u64,
}

#[derive(SimpleObject)]
pub struct AdminTranscriptionConnectionCheckType {
  pub successful: bool,
  pub catalog_supported: Option<bool>,
  /// Catalog membership is not evidence of successful speech recognition.
  pub model_listed: Option<bool>,
  pub error: Option<String>,
}

impl From<TranscriptionConnectionOutcome> for AdminTranscriptionConnectionCheckType {
  fn from(outcome: TranscriptionConnectionOutcome) -> Self {
    match outcome {
      Ok(result) => Self {
        successful: true,
        catalog_supported: Some(result.catalog_supported),
        model_listed: result.model_listed,
        error: None,
      },
      Err(error) => Self {
        successful: false,
        catalog_supported: None,
        model_listed: None,
        error: Some(error),
      },
    }
  }
}

#[derive(SimpleObject)]
pub struct AdminTranscriptionStatusType {
  pub capability: TranscriptionCapabilityType,
  pub last_connection_check: Option<AdminTranscriptionConnectionCheckType>,
}

/// Both projections bind capability and check outcome to one effective snapshot.
/// Retired adapter instances can finish, but cannot publish into its replacement.
async fn snapshot(state: &ApiState) -> (TranscriptionCapabilityType, Option<Arc<TranscriptionService>>) {
  let (config, service) = state.transcription_snapshot().await;
  let configured = config.configured();
  let service = match service {
    Ok(service) => Some(service),
    Err(error) => {
      if configured {
        tracing::error!(error = %error, "failed to initialize speech transport");
      }
      None
    }
  };
  let status = if !config.enabled {
    TranscriptionAvailability::Disabled
  } else if !configured {
    TranscriptionAvailability::Unconfigured
  } else if let Some(service) = &service {
    match service.last_check().await {
      None => TranscriptionAvailability::NotChecked,
      Some(true) => TranscriptionAvailability::Available,
      Some(false) => TranscriptionAvailability::Unavailable,
    }
  } else {
    TranscriptionAvailability::Unavailable
  };
  (
    TranscriptionCapabilityType {
      enabled: config.enabled,
      configured,
      status,
      max_input_bytes: config.max_input_bytes,
      max_duration_seconds: config.max_duration_seconds,
    },
    service,
  )
}

pub async fn admin_status(state: &ApiState) -> AdminTranscriptionStatusType {
  let (capability, service) = snapshot(state).await;
  let last_connection_check = match service {
    Some(service) => service.last_connection_check().await.map(Into::into),
    None => None,
  };
  AdminTranscriptionStatusType {
    capability,
    last_connection_check,
  }
}

#[ComplexObject]
impl ServerConfigType {
  /// Capability is resolved outside the cached serverConfig value so a live
  /// config change or observed service failure cannot leave stale readiness.
  async fn transcription(&self, ctx: &Context<'_>) -> Result<TranscriptionCapabilityType> {
    let state = ctx.data::<Arc<ApiState>>()?;
    Ok(snapshot(state).await.0)
  }
}

#[derive(SimpleObject, Clone)]
pub struct TranscriptionEnrichmentType {
  pub id: String,
  pub status: super::AiJobStatusType,
  pub error_message: Option<String>,
  pub summary: Option<String>,
  pub actions: Option<String>,
}
impl From<myoxus_domain::entities::CopilotJob> for TranscriptionEnrichmentType {
  fn from(job: myoxus_domain::entities::CopilotJob) -> Self {
    use myoxus_domain::entities::CopilotJobState;
    Self {
      id: job.id.to_string(),
      status: match job.state {
        CopilotJobState::Finished => super::AiJobStatusType::Finished,
        CopilotJobState::Failed => super::AiJobStatusType::Failed,
        _ => super::AiJobStatusType::Running,
      },
      error_message: job.error_message,
      summary: job.payload["summary"].as_str().map(str::to_owned),
      actions: job.payload["actions"].as_str().map(str::to_owned),
    }
  }
}

#[ComplexObject]
impl super::TranscriptionResultType {
  /// Readable even with Copilot disabled. Readback never invokes a provider.
  async fn enrichment(&self, ctx: &Context<'_>) -> Result<Option<TranscriptionEnrichmentType>> {
    let state = ctx.data::<Arc<ApiState>>()?;
    let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
    let service =
      myoxus_application::transcription::enrichment::TranscriptionEnrichmentService::new(state.transcription_results());
    let job = uuid::Uuid::parse_str(&self.id).map_err(|_| "invalid job id")?;
    let source = service
      .source(snapshot.user.id, None, job, &state.permission_service())
      .await
      .map_err(super::utils::map_gql_error)?;
    Ok(
      service
        .read(&source)
        .await
        .map_err(super::utils::map_gql_error)?
        .map(Into::into),
    )
  }
}

pub(super) async fn generate_enrichment(
  ctx: &Context<'_>,
  workspace: String,
  job: String,
  summary: bool,
  actions: bool,
) -> Result<TranscriptionEnrichmentType> {
  use myoxus_application::transcription::enrichment::{
    EnrichmentProvider, EnrichmentRequest, TranscriptionEnrichmentService,
  };
  let state = ctx.data::<Arc<ApiState>>()?;
  let snapshot = super::ensure_authenticated_snapshot(ctx, state).await?;
  let workspace = uuid::Uuid::parse_str(&workspace).map_err(|_| "invalid workspace id")?;
  let job = uuid::Uuid::parse_str(&job).map_err(|_| "invalid job id")?;
  super::auth::assert_copilot_workspace_access(state, snapshot.user.id, workspace, "enrich_audio_transcription")
    .await?;
  let enabled = state
    .workspace()
    .get_workspace(workspace)
    .await
    .map_err(super::utils::map_gql_error)?
    .is_some_and(|workspace| workspace.enable_ai);
  if !enabled {
    return Err(async_graphql::Error::new("workspace Copilot is not enabled"));
  }
  let config = &state.config.copilot;
  let model = config
    .providers
    .get(&config.default_provider)
    .filter(|p| p.enabled)
    .and_then(|p| p.models.first())
    .ok_or_else(|| async_graphql::Error::new("generative provider is not configured"))?;
  let service = TranscriptionEnrichmentService::new(state.transcription_results());
  let permissions = state.permission_service();
  let source = service
    .source(snapshot.user.id, Some(workspace), job, &permissions)
    .await
    .map_err(super::utils::map_gql_error)?;
  service
    .generate(
      source,
      EnrichmentRequest { summary, actions },
      EnrichmentProvider {
        registry: state.llm_provider_registry(),
        provider: &config.default_provider,
        fallback: &config.fallback_providers,
        model,
        timeout_ms: config.request_timeout_ms,
      },
      &permissions,
    )
    .await
    .map(Into::into)
    .map_err(super::utils::map_gql_error)
}
