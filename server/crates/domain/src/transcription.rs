// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable speech results use the existing audio jobs and transcript tables.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{entities::CopilotJob, repositories::RepoResult};

/// Non-secret execution values captured when an authorized job is admitted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptionExecutionConfig {
  pub source: String,
  pub model: String,
  pub language: Option<String>,
  pub request_timeout_ms: u64,
  pub max_input_bytes: u64,
  pub max_response_bytes: usize,
  pub max_duration_seconds: u64,
  pub max_concurrency: usize,
}

/// Missing timing or speaker metadata never removes segment text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptionSegment {
  pub text: String,
  pub start_seconds: Option<f64>,
  pub end_seconds: Option<f64>,
  pub speaker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResponse {
  pub text: String,
  pub language: Option<String>,
  pub duration_seconds: Option<f64>,
  #[serde(default)]
  pub segments: Vec<TranscriptionSegment>,
}

/// All supplied filters are conjunctive. User ownership is never optional.
#[derive(Debug, Clone)]
pub struct TranscriptionResultQuery {
  pub user_id: Uuid,
  pub workspace_id: Option<Uuid>,
  pub job_id: Option<Uuid>,
  pub blob_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredTranscription {
  pub id: Uuid,
  pub response: TranscriptionResponse,
  pub model: String,
  // Historical optional results remain readable; speech never generates them.
  pub title: Option<String>,
  pub summary: Option<String>,
  pub actions: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AudioJobResult {
  pub job: CopilotJob,
  pub transcript: Option<StoredTranscription>,
}

/// The nonce identifies one admitted execution. Redis transports this identity
/// but PostgreSQL alone owns its authority and transitions.
#[derive(Debug, Clone)]
pub struct AudioJobAttempt {
  pub job: CopilotJob,
  pub id: Uuid,
  pub attempts: u32,
  pub deadline: chrono::DateTime<chrono::Utc>,
}

#[async_trait]
pub trait TranscriptionResultRepository: Send + Sync {
  /// Enrichment jobs bind to an immutable canonical result, never transition the
  /// source speech job, and retain prior optional output on failure.
  async fn enrichment(&self, source: &AudioJobResult) -> RepoResult<Option<CopilotJob>>;
  async fn begin_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool>;
  /// Commit output and terminal state together; expired or replaced results
  /// reject late completion without touching speech or audio.
  async fn finish_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool>;
  async fn query(&self, query: &TranscriptionResultQuery) -> RepoResult<Vec<AudioJobResult>>;
  async fn create_job(&self, job: &CopilotJob, deadline: chrono::DateTime<chrono::Utc>) -> RepoResult<CopilotJob>;
  async fn attempt(&self, job_id: Uuid) -> RepoResult<Option<AudioJobAttempt>>;
  async fn claim_attempt(
    &self,
    job_id: Uuid,
    attempt_id: Uuid,
    lease_seconds: u32,
  ) -> RepoResult<Option<AudioJobAttempt>>;
  /// Compare-and-swap retry retains the canonical result and invalidates any
  /// worker using the previous configuration. Competing retries cannot reset it.
  async fn retry_attempt(
    &self,
    prior: &AudioJobAttempt,
    payload: serde_json::Value,
    deadline: chrono::DateTime<chrono::Utc>,
  ) -> RepoResult<Option<AudioJobAttempt>>;
  /// Recover stale work and select a bounded due batch, reserving its next
  /// dispatch time before returning. Redis loss never removes the SQL job.
  async fn recover(&self, max_attempts: u32, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>>;
  async fn finish_preparation(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool>;
  async fn abort_preparation(&self, job_id: Uuid, attempt_id: Uuid, error: &str) -> RepoResult<bool>;
  async fn cleanup_due(&self, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>>;
  async fn finish_cleanup(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool>;
  /// Only audio jobs can be completed. Result and finished state commit together.
  async fn complete(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    model: &str,
    response: &TranscriptionResponse,
    attempt_id: Uuid,
  ) -> RepoResult<bool>;
  /// Failure retains any prior usable result during a refresh.
  async fn fail(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    error: &str,
    attempt_id: Uuid,
    max_attempts: u32,
  ) -> RepoResult<bool>;
  /// Delete result content only; retain the job and its source audio.
  async fn delete_result(&self, job_id: Uuid, workspace_id: Uuid) -> RepoResult<()>;
}
