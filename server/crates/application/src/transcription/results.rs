// SPDX-License-Identifier: AGPL-3.0-or-later
//! Result lifecycle is independent of transport availability and Copilot.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotJob, CopilotJobState},
  repositories::{CopilotRepository, PageRequest, RepoResult, RepositoryError},
  transcription::{
    AudioJobAttempt, AudioJobResult, StoredTranscription, TranscriptionResponse, TranscriptionResultQuery,
    TranscriptionResultRepository,
  },
};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::instrument;
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::permission::{AccessController, PermissionService, WorkspaceResource};
use myoxus_domain::permission::WorkspaceAction;

pub struct TranscriptionResultsService {
  repository: Arc<dyn TranscriptionResultRepository>,
}

impl TranscriptionResultsService {
  pub fn new(repository: Arc<dyn TranscriptionResultRepository>) -> Self {
    Self { repository }
  }

  #[instrument(skip_all)]
  pub async fn query(
    &self,
    query: TranscriptionResultQuery,
    permissions: &PermissionService,
  ) -> AuthResult<Vec<AudioJobResult>> {
    if let Some(workspace_id) = query.workspace_id {
      permissions
        .assert(
          &WorkspaceResource {
            user_id: query.user_id,
            workspace_id,
          },
          WorkspaceAction::Transcription,
        )
        .await?;
    }
    let rows = self
      .repository
      .query(&query)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let mut authorized = Vec::new();
    for row in rows {
      if let Some(workspace_id) = row.job.workspace_id {
        if permissions
          .can(
            &WorkspaceResource {
              user_id: query.user_id,
              workspace_id,
            },
            WorkspaceAction::Transcription,
          )
          .await
        {
          authorized.push(row);
        }
      }
    }
    Ok(authorized)
  }

  #[instrument(skip_all)]
  pub async fn create_job(
    &self,
    workspace_id: Uuid,
    user_id: Uuid,
    payload: Value,
    deadline: chrono::DateTime<Utc>,
  ) -> AuthResult<CopilotJob> {
    let now = Utc::now();
    self
      .repository
      .create_job(
        &CopilotJob {
          id: Uuid::new_v4(),
          job_type: "audio_transcription".into(),
          state: CopilotJobState::Pending,
          workspace_id: Some(workspace_id),
          user_id: Some(user_id),
          payload,
          error_message: None,
          created_at: now,
          updated_at: now,
        },
        deadline,
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  pub fn repository(&self) -> Arc<dyn TranscriptionResultRepository> {
    self.repository.clone()
  }

  #[instrument(skip_all)]
  pub async fn complete(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    model: &str,
    response: &TranscriptionResponse,
    attempt_id: Uuid,
  ) -> AuthResult<bool> {
    self
      .repository
      .complete(job_id, workspace_id, blob_id, model, response, attempt_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  #[instrument(skip_all)]
  pub async fn fail(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    error: &str,
    attempt_id: Uuid,
    max_attempts: u32,
  ) -> AuthResult<bool> {
    self
      .repository
      .fail(job_id, workspace_id, blob_id, error, attempt_id, max_attempts)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }

  #[instrument(skip_all)]
  pub async fn delete_result(&self, job_id: Uuid, workspace_id: Uuid) -> AuthResult<()> {
    self
      .repository
      .delete_result(job_id, workspace_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }
}

/// The test adapter shares the existing job repository. A result lock covers
/// both readback and completion so consumers cannot observe half a transition.
pub struct InMemoryTranscriptionResultRepository {
  jobs: Arc<dyn CopilotRepository>,
  results: Mutex<MemoryResults>,
}

#[derive(Default)]
struct MemoryResults {
  active: HashMap<Uuid, String>,
  by_model: HashMap<(Uuid, String), StoredTranscription>,
  attempts: HashMap<Uuid, MemoryAttempt>,
}

#[derive(Clone)]
struct MemoryAttempt {
  id: Uuid,
  count: u32,
  deadline: chrono::DateTime<Utc>,
  lease: Option<chrono::DateTime<Utc>>,
  dispatch: chrono::DateTime<Utc>,
  cleanup: Option<chrono::DateTime<Utc>>,
}
impl MemoryAttempt {
  fn project(&self, job: CopilotJob) -> AudioJobAttempt {
    AudioJobAttempt {
      job,
      id: self.id,
      attempts: self.count,
      deadline: self.deadline,
    }
  }
}

impl InMemoryTranscriptionResultRepository {
  pub fn new(jobs: Arc<dyn CopilotRepository>) -> Self {
    Self {
      jobs,
      results: Mutex::default(),
    }
  }
}

#[async_trait]
impl TranscriptionResultRepository for InMemoryTranscriptionResultRepository {
  async fn enrichment(&self, source: &AudioJobResult) -> RepoResult<Option<CopilotJob>> {
    let _results = self.results.lock().await;
    let jobs = self
      .jobs
      .list_copilot_jobs(
        source.job.workspace_id,
        source.job.user_id,
        None,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await?;
    let mut jobs: Vec<_> = jobs
      .into_iter()
      .filter(|job| {
        job.job_type == "audio_enrichment"
          && job.payload["sourceJobId"] == source.job.id.to_string()
          && job.payload["sourceRevision"] == source.job.updated_at.to_rfc3339()
          && source
            .transcript
            .as_ref()
            .is_some_and(|t| job.payload["transcriptId"] == t.id.to_string())
      })
      .collect();
    jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    let Some(mut job) = jobs.into_iter().next() else {
      return Ok(None);
    };
    if job.state == CopilotJobState::Running
      && job.payload["deadline"].as_i64().unwrap_or(0) <= Utc::now().timestamp_millis()
    {
      job = self
        .jobs
        .update_copilot_job_state(
          job.id,
          CopilotJobState::Failed,
          Some("Enrichment request interrupted or timed out".into()),
          Utc::now(),
        )
        .await?;
    }
    Ok(Some(job))
  }

  async fn begin_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool> {
    let results = self.results.lock().await;
    if !source.transcript.as_ref().is_some_and(|t| {
      results
        .active
        .get(&source.job.id)
        .and_then(|m| results.by_model.get(&(source.job.id, m.clone())))
        .is_some_and(|current| current.id == t.id)
    }) {
      return Err(RepositoryError::NotFound("transcript"));
    }
    let jobs = self
      .jobs
      .list_copilot_jobs(
        source.job.workspace_id,
        source.job.user_id,
        None,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await?;
    if jobs.iter().any(|current| {
      current.job_type == "audio_enrichment"
        && current.state == CopilotJobState::Running
        && current.payload["sourceJobId"] == job.payload["sourceJobId"]
        && current.payload["transcriptId"] == job.payload["transcriptId"]
        && current.payload["sourceRevision"] == job.payload["sourceRevision"]
        && current.payload["deadline"].as_i64().unwrap_or(0) > Utc::now().timestamp_millis()
    }) {
      return Ok(false);
    }
    let current = self
      .jobs
      .get_copilot_job(source.job.id)
      .await?
      .ok_or(RepositoryError::NotFound("transcript"))?;
    if current.state != CopilotJobState::Finished || current.updated_at != source.job.updated_at {
      return Err(RepositoryError::NotFound("completed transcript"));
    }
    self.jobs.create_copilot_job(job).await?;
    Ok(true)
  }

  async fn finish_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool> {
    let results = self.results.lock().await;
    let speech = self.jobs.get_copilot_job(source.job.id).await?;
    if !speech.is_some_and(|j| j.state == CopilotJobState::Finished && j.updated_at == source.job.updated_at) {
      return Ok(false);
    }
    let current = self.jobs.get_copilot_job(job.id).await?;
    if !current.is_some_and(|j| {
      j.state == CopilotJobState::Running && j.payload["deadline"].as_i64().unwrap_or(0) > Utc::now().timestamp_millis()
    }) || !source.transcript.as_ref().is_some_and(|t| {
      results
        .active
        .get(&source.job.id)
        .and_then(|m| results.by_model.get(&(source.job.id, m.clone())))
        .is_some_and(|current| current.id == t.id)
    }) {
      return Ok(false);
    }
    self
      .jobs
      .update_copilot_job_payload(job.id, job.payload.clone())
      .await?;
    self
      .jobs
      .update_copilot_job_state(job.id, job.state.clone(), job.error_message.clone(), Utc::now())
      .await?;
    Ok(true)
  }

  async fn query(&self, query: &TranscriptionResultQuery) -> RepoResult<Vec<AudioJobResult>> {
    let results = self.results.lock().await;
    let mut jobs = self
      .jobs
      .list_copilot_jobs(
        query.workspace_id,
        Some(query.user_id),
        None,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await?;
    jobs.retain(|job| {
      job.job_type == "audio_transcription"
        && query.job_id.is_none_or(|id| job.id == id)
        && query
          .blob_id
          .as_ref()
          .is_none_or(|blob| job.payload["blobId"].as_str() == Some(blob))
    });
    jobs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| b.id.cmp(&a.id)));
    Ok(
      jobs
        .into_iter()
        .take(50)
        .map(|job| AudioJobResult {
          transcript: results
            .active
            .get(&job.id)
            .and_then(|model| results.by_model.get(&(job.id, model.clone())))
            .cloned(),
          job,
        })
        .collect(),
    )
  }

  async fn create_job(&self, job: &CopilotJob, deadline: chrono::DateTime<Utc>) -> RepoResult<CopilotJob> {
    let mut results = self.results.lock().await;
    let job = self.jobs.create_copilot_job(job).await?;
    results.attempts.insert(
      job.id,
      MemoryAttempt {
        id: Uuid::new_v4(),
        count: 0,
        deadline,
        lease: None,
        dispatch: Utc::now(),
        cleanup: None,
      },
    );
    Ok(job)
  }

  async fn attempt(&self, job_id: Uuid) -> RepoResult<Option<AudioJobAttempt>> {
    let results = self.results.lock().await;
    let Some(job) = self.jobs.get_copilot_job(job_id).await? else {
      return Ok(None);
    };
    Ok(results.attempts.get(&job_id).map(|attempt| attempt.project(job)))
  }

  async fn claim_attempt(
    &self,
    job_id: Uuid,
    attempt_id: Uuid,
    lease_seconds: u32,
  ) -> RepoResult<Option<AudioJobAttempt>> {
    let mut results = self.results.lock().await;
    let Some(control) = results.attempts.get_mut(&job_id) else {
      return Ok(None);
    };
    let Some(job) = self.jobs.get_copilot_job(job_id).await? else {
      return Ok(None);
    };
    if control.id != attempt_id
      || job.state != CopilotJobState::Pending
      || job.payload["inputReady"] == Value::Bool(false)
      || control.deadline <= Utc::now()
    {
      return Ok(None);
    }
    let job = self
      .jobs
      .update_copilot_job_state(job_id, CopilotJobState::Running, None, Utc::now())
      .await?;
    control.count += 1;
    control.lease = Some(
      control
        .deadline
        .min(Utc::now() + chrono::Duration::seconds(i64::from(lease_seconds))),
    );
    Ok(Some(control.project(job)))
  }

  async fn retry_attempt(
    &self,
    prior: &AudioJobAttempt,
    payload: Value,
    deadline: chrono::DateTime<Utc>,
  ) -> RepoResult<Option<AudioJobAttempt>> {
    let mut results = self.results.lock().await;
    let Some(control) = results.attempts.get_mut(&prior.job.id) else {
      return Ok(None);
    };
    let Some(job) = self.jobs.get_copilot_job(prior.job.id).await? else {
      return Ok(None);
    };
    if control.id != prior.id || job.user_id != prior.job.user_id || job.workspace_id != prior.job.workspace_id {
      return Ok(None);
    }
    self.jobs.update_copilot_job_payload(job.id, payload).await?;
    let job = self
      .jobs
      .update_copilot_job_state(job.id, CopilotJobState::Pending, None, Utc::now())
      .await?;
    *control = MemoryAttempt {
      id: Uuid::new_v4(),
      count: 0,
      deadline,
      lease: None,
      dispatch: Utc::now(),
      cleanup: Some(Utc::now()),
    };
    Ok(Some(control.project(job)))
  }

  async fn recover(&self, max_attempts: u32, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>> {
    let mut results = self.results.lock().await;
    let mut jobs = self
      .jobs
      .list_copilot_jobs(
        None,
        None,
        None,
        PageRequest {
          limit: i64::MAX,
          offset: 0,
        },
      )
      .await?;
    jobs.sort_by_key(|job| (job.created_at, job.id));
    let now = Utc::now();
    let mut due = Vec::new();
    for mut job in jobs {
      if job.job_type != "audio_transcription"
        || !matches!(
          job.state,
          CopilotJobState::Pending | CopilotJobState::Running | CopilotJobState::Claimed
        )
      {
        continue;
      }
      let control = results.attempts.entry(job.id).or_insert_with(|| MemoryAttempt {
        id: Uuid::new_v4(),
        count: 0,
        deadline: now
          + chrono::Duration::milliseconds(
            (job.payload["transcriptionConfig"]["request_timeout_ms"]
              .as_u64()
              .unwrap_or(0)
              .min(3_600_000)
              .saturating_mul(u64::from(max_attempts) + 1)
              .saturating_add(
                u64::from(dispatch_seconds)
                  .saturating_mul(1000)
                  .saturating_mul(u64::from(max_attempts)),
              ))
            .min(i64::MAX as u64) as i64,
          ),
        lease: Some(now),
        dispatch: now,
        cleanup: None,
      });
      let interrupted = matches!(job.state, CopilotJobState::Running | CopilotJobState::Claimed)
        && control.lease.is_none_or(|value| value <= now);
      if control.deadline <= now || interrupted {
        let terminal = control.deadline <= now || control.count >= max_attempts;
        job = self
          .jobs
          .update_copilot_job_state(
            job.id,
            if terminal {
              CopilotJobState::Failed
            } else {
              CopilotJobState::Pending
            },
            Some(
              if control.deadline <= now {
                "speech job deadline exceeded"
              } else {
                "speech attempt interrupted"
              }
              .into(),
            ),
            now,
          )
          .await?;
        control.id = Uuid::new_v4();
        control.lease = None;
        control.dispatch = now;
        if terminal {
          control.cleanup = Some(now);
        }
      }
      if job.state == CopilotJobState::Pending
        && control.dispatch <= now
        && control.deadline > now
        && job.payload["inputReady"] != Value::Bool(false)
      {
        control.dispatch = now + chrono::Duration::seconds(i64::from(dispatch_seconds));
        due.push(control.project(job));
        if due.len() == 50 {
          break;
        }
      }
    }
    Ok(due)
  }

  async fn finish_preparation(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool> {
    let results = self.results.lock().await;
    let Some(control) = results.attempts.get(&job_id) else {
      return Ok(false);
    };
    let Some(mut job) = self.jobs.get_copilot_job(job_id).await? else {
      return Ok(false);
    };
    if control.id != attempt_id
      || job.state != CopilotJobState::Pending
      || job.payload["inputReady"] == Value::Bool(false)
      || control.deadline <= Utc::now()
    {
      return Ok(false);
    }
    job.payload["inputReady"] = Value::Bool(true);
    self.jobs.update_copilot_job_payload(job_id, job.payload).await?;
    Ok(true)
  }

  async fn abort_preparation(&self, job_id: Uuid, attempt_id: Uuid, error: &str) -> RepoResult<bool> {
    let mut results = self.results.lock().await;
    let Some(control) = results.attempts.get_mut(&job_id) else {
      return Ok(false);
    };
    let Some(job) = self.jobs.get_copilot_job(job_id).await? else {
      return Ok(false);
    };
    if control.id != attempt_id
      || job.state != CopilotJobState::Pending
      || job.payload["inputReady"] != Value::Bool(false)
    {
      return Ok(false);
    }
    self
      .jobs
      .update_copilot_job_state(job_id, CopilotJobState::Failed, Some(error.into()), Utc::now())
      .await?;
    control.id = Uuid::new_v4();
    control.cleanup = Some(Utc::now());
    Ok(true)
  }

  async fn cleanup_due(&self, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>> {
    let mut results = self.results.lock().await;
    let now = Utc::now();
    let mut due = Vec::new();
    for (job_id, control) in &mut results.attempts {
      if control.cleanup.is_some_and(|value| value <= now) {
        if let Some(job) = self.jobs.get_copilot_job(*job_id).await? {
          control.cleanup = Some(now + chrono::Duration::seconds(i64::from(dispatch_seconds)));
          due.push(control.project(job));
          if due.len() == 50 {
            break;
          }
        }
      }
    }
    Ok(due)
  }

  async fn finish_cleanup(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool> {
    let mut results = self.results.lock().await;
    let Some(control) = results.attempts.get_mut(&job_id) else {
      return Ok(false);
    };
    if control.id != attempt_id {
      return Ok(false);
    }
    let Some(mut job) = self.jobs.get_copilot_job(job_id).await? else {
      return Ok(false);
    };
    if let Some(payload) = job.payload.as_object_mut() {
      payload.remove("temporaryInputs");
    }
    self.jobs.update_copilot_job_payload(job_id, job.payload).await?;
    control.cleanup = None;
    Ok(true)
  }

  async fn complete(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    model: &str,
    response: &TranscriptionResponse,
    attempt_id: Uuid,
  ) -> RepoResult<bool> {
    let mut results = self.results.lock().await;
    let job = self
      .jobs
      .get_copilot_job(job_id)
      .await?
      .ok_or(RepositoryError::NotFound("audio_job"))?;
    if job.job_type != "audio_transcription"
      || job.workspace_id != Some(workspace_id)
      || job.payload["blobId"].as_str() != Some(blob_id)
    {
      return Err(RepositoryError::NotFound("audio_job"));
    }
    if job.state != CopilotJobState::Running
      || results
        .attempts
        .get(&job_id)
        .is_none_or(|control| control.id != attempt_id || control.deadline <= Utc::now())
    {
      return Ok(false);
    }
    self
      .jobs
      .update_copilot_job_state(job_id, CopilotJobState::Finished, None, Utc::now())
      .await?;
    let key = (job_id, model.to_string());
    let prior = results.by_model.get(&key);
    let result = StoredTranscription {
      id: prior.map(|result| result.id).unwrap_or_else(Uuid::new_v4),
      response: response.clone(),
      model: model.into(),
      title: prior.and_then(|result| result.title.clone()),
      summary: prior.and_then(|result| result.summary.clone()),
      actions: prior.and_then(|result| result.actions.clone()),
    };
    results.active.insert(job_id, model.into());
    results.by_model.insert(key, result);
    if let Some(control) = results.attempts.get_mut(&job_id) {
      control.cleanup = Some(Utc::now());
      control.lease = None;
    }
    Ok(true)
  }

  async fn fail(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    error: &str,
    attempt_id: Uuid,
    max_attempts: u32,
  ) -> RepoResult<bool> {
    let mut results = self.results.lock().await;
    let job = self
      .jobs
      .get_copilot_job(job_id)
      .await?
      .ok_or(RepositoryError::NotFound("audio_job"))?;
    if job.job_type != "audio_transcription"
      || job.workspace_id != Some(workspace_id)
      || job.payload["blobId"].as_str() != Some(blob_id)
    {
      return Err(RepositoryError::NotFound("audio_job"));
    }
    let Some(control) = results.attempts.get_mut(&job_id) else {
      return Ok(false);
    };
    if control.id != attempt_id || job.state != CopilotJobState::Running {
      return Ok(false);
    }
    let state = if control.count < max_attempts && control.deadline > Utc::now() {
      CopilotJobState::Pending
    } else {
      CopilotJobState::Failed
    };
    if state == CopilotJobState::Failed {
      control.cleanup = Some(Utc::now());
    }
    self
      .jobs
      .update_copilot_job_state(job_id, state, Some(error.into()), Utc::now())
      .await?;
    control.id = Uuid::new_v4();
    control.lease = None;
    control.dispatch = Utc::now();
    Ok(true)
  }

  async fn delete_result(&self, job_id: Uuid, workspace_id: Uuid) -> RepoResult<()> {
    let mut results = self.results.lock().await;
    let job = self
      .jobs
      .get_copilot_job(job_id)
      .await?
      .ok_or(RepositoryError::NotFound("audio_job"))?;
    if job.job_type != "audio_transcription" || job.workspace_id != Some(workspace_id) {
      return Err(RepositoryError::NotFound("audio_job"));
    }
    if let Some(control) = results.attempts.get_mut(&job_id) {
      control.id = Uuid::new_v4();
      control.lease = None;
      control.cleanup = Some(Utc::now());
    }
    if matches!(
      job.state,
      CopilotJobState::Pending | CopilotJobState::Running | CopilotJobState::Claimed
    ) {
      self
        .jobs
        .update_copilot_job_state(
          job_id,
          CopilotJobState::Failed,
          Some("transcript deleted".into()),
          Utc::now(),
        )
        .await?;
    }
    if let Some(model) = results.active.remove(&job_id) {
      results.by_model.remove(&(job_id, model));
    }
    Ok(())
  }
}
