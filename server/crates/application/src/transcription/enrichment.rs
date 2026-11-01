// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit generative output uses separate existing Copilot jobs. Speech and
//! source audio are read-only inputs, including on timeout or provider failure.

use super::results::TranscriptionResultsService;
use crate::{
  auth::{AuthError, AuthResult},
  copilot::provider::{LlmMessage, LlmProviderRegistry, LlmRequest, LlmRole},
  permission::{AccessController, PermissionService, WorkspaceResource},
};
use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotJob, CopilotJobState},
  transcription::{AudioJobResult, TranscriptionResultQuery},
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tracing::instrument;
use uuid::Uuid;

pub struct EnrichmentRequest {
  pub summary: bool,
  pub actions: bool,
}

/// The API supplies the same independently authorized configuration as chat.
/// A request has one bounded lifetime; interruption never schedules LLM replay.
pub struct EnrichmentProvider<'a> {
  pub registry: &'a LlmProviderRegistry,
  pub provider: &'a str,
  pub fallback: &'a [String],
  pub model: &'a str,
  pub timeout_ms: u64,
}

pub struct TranscriptionEnrichmentService {
  results: Arc<TranscriptionResultsService>,
}
impl TranscriptionEnrichmentService {
  pub fn new(results: Arc<TranscriptionResultsService>) -> Self {
    Self { results }
  }

  #[instrument(skip_all)]
  pub async fn source(
    &self,
    user: Uuid,
    workspace: Option<Uuid>,
    job: Uuid,
    permissions: &PermissionService,
  ) -> AuthResult<AudioJobResult> {
    self
      .results
      .query(
        TranscriptionResultQuery {
          user_id: user,
          workspace_id: workspace,
          job_id: Some(job),
          blob_id: None,
        },
        permissions,
      )
      .await?
      .into_iter()
      .next()
      .ok_or(AuthError::InvalidInput("completed transcript not found".into()))
  }

  #[instrument(skip_all)]
  pub async fn read(&self, source: &AudioJobResult) -> AuthResult<Option<CopilotJob>> {
    self
      .results
      .repository()
      .enrichment(source)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))
  }

  #[instrument(skip_all)]
  pub async fn generate(
    &self,
    source: AudioJobResult,
    requested: EnrichmentRequest,
    provider: EnrichmentProvider<'_>,
    permissions: &PermissionService,
  ) -> AuthResult<CopilotJob> {
    if !requested.summary && !requested.actions {
      return Err(AuthError::InvalidInput("select summary or action items".into()));
    }
    let user_id = source.job.user_id.ok_or(AuthError::ActionForbidden)?;
    let workspace_id = source.job.workspace_id.ok_or(AuthError::ActionForbidden)?;
    permissions
      .assert(
        &WorkspaceResource { user_id, workspace_id },
        myoxus_domain::permission::WorkspaceAction::Copilot,
      )
      .await?;
    let transcript = source
      .transcript
      .as_ref()
      .filter(|_| source.job.state == CopilotJobState::Finished)
      .ok_or(AuthError::InvalidInput("transcription is not complete".into()))?;
    if transcript.response.text.len() > 256 * 1024 {
      return Err(AuthError::InvalidInput(
        "transcript exceeds enrichment input limit".into(),
      ));
    }
    let prior = self.read(&source).await?;
    if prior.as_ref().is_some_and(|job| job.state == CopilotJobState::Running) {
      return Ok(prior.unwrap());
    }
    let summary = prior
      .as_ref()
      .and_then(|j| j.payload["summary"].as_str())
      .map(str::to_owned)
      .or_else(|| transcript.summary.clone());
    let actions = prior
      .as_ref()
      .and_then(|j| j.payload["actions"].as_str())
      .map(str::to_owned)
      .or_else(|| transcript.actions.clone());
    let now = Utc::now();
    let timeout = Duration::from_millis(provider.timeout_ms.clamp(1, 120_000));
    // Reserve a small persistence window after the bounded provider call.
    let mut job = CopilotJob {
      id: Uuid::new_v4(),
      job_type: "audio_enrichment".into(),
      state: CopilotJobState::Running,
      workspace_id: Some(workspace_id),
      user_id: Some(user_id),
      error_message: None,
      created_at: now,
      updated_at: now,
      payload: json!({"sourceJobId":source.job.id,"transcriptId":transcript.id,"sourceRevision":source.job.updated_at.to_rfc3339(),"deadline":now.timestamp_millis() + timeout.as_millis() as i64 + 5000,
        "summaryRequested":requested.summary,"actionsRequested":requested.actions,"summary":summary,"actions":actions}),
    };
    if !self
      .results
      .repository()
      .begin_enrichment(&source, &job)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
    {
      return self
        .read(&source)
        .await?
        .ok_or(AuthError::InvalidInput("enrichment request changed".into()));
    }
    let generated = tokio::time::timeout(timeout, async {
      let mut outputs = Vec::new();
      for (field, selected, instruction) in [
        ("summary", requested.summary, "Summarize this transcript concisely. Use its language. Return only the summary, without inventing facts."),
        ("actions", requested.actions, "Extract suggested action items from this transcript in its language. Return a plain text list. Do not invent tasks, owners or deadlines. If none are stated, say so.")
      ] {
        if !selected { continue; }
        let request = LlmRequest { reasoning: None, model: provider.model.into(), messages: vec![
          LlmMessage { role: LlmRole::System, content: instruction.into(), name: None, tool_call_id: None },
          LlmMessage { role: LlmRole::User, content: transcript.response.text.clone().into(), name: None, tool_call_id: None }
        ], temperature: None, max_tokens: Some(4096), tools: vec![], metadata: json!({}) };
        let (_, response) = provider.registry.complete_with_fallback(&request, provider.provider, provider.fallback).await.map_err(|_| ())?;
        if response.output_text.trim().is_empty() || response.output_text.len() > 64 * 1024 { return Err(()); }
        outputs.push((field, response.output_text));
      }
      Ok::<_, ()>(outputs)
    }).await;
    match generated {
      Ok(Ok(outputs)) => {
        for (field, output) in outputs {
          job.payload[field] = json!(output);
        }
        job.state = CopilotJobState::Finished;
      }
      _ => {
        job.state = CopilotJobState::Failed;
        // Provider errors may contain response content. Persist/log only this
        // stable local failure, never the provider body or the source transcript.
        job.error_message = Some("Summary/action generation failed or timed out".into());
        tracing::warn!(job_id = %job.id, "transcript enrichment failed");
      }
    }
    if !self
      .results
      .repository()
      .finish_enrichment(&source, &job)
      .await
      .map_err(|e| AuthError::Storage(e.to_string()))?
    {
      return Err(AuthError::InvalidInput(
        "transcript changed or enrichment request expired".into(),
      ));
    }
    Ok(job)
  }
}
