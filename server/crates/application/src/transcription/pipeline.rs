// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authorized durable audio admission, execution and existing-queue recovery.

use super::{
  ProviderError, TranscriptionAdmission, TranscriptionExecutionConfig, TranscriptionResponse, TranscriptionService,
  input::{AudioInputInfo, AudioInputInspector, AudioInputWork},
};
use crate::{
  auth::{AuthError, AuthResult},
  permission::{AccessController, PermissionService, WorkspaceResource},
  ports::{blob::BlobKey, blob_service::BlobService},
  worker::WorkQueuePort,
};
use bytes::Bytes;
use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotJob, CopilotJobState},
  permission::WorkspaceAction,
  transcription::{AudioJobAttempt, TranscriptionResultRepository},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
  fs::File,
  io::{Read, Seek, SeekFrom},
  sync::Arc,
  time::Instant,
};
use tracing::instrument;
use uuid::Uuid;

pub struct TranscriptionUpload {
  pub filename: String,
  pub file: File,
}

/// Values supplied by the existing worker configuration, not a speech-specific
/// retry setting. The same policy bounds queue wait and crash recovery.
#[derive(Clone, Copy)]
pub struct TranscriptionJobPolicy {
  pub max_attempts: u32,
  pub dispatch_seconds: u32,
}

impl TranscriptionJobPolicy {
  fn deadline(self, config: &TranscriptionExecutionConfig) -> AuthResult<chrono::DateTime<Utc>> {
    let attempts = u64::from(self.max_attempts.max(1));
    let millis = config
      .request_timeout_ms
      .checked_mul(attempts + 1)
      .and_then(|value| {
        u64::from(self.dispatch_seconds)
          .checked_mul(1000)?
          .checked_mul(attempts)?
          .checked_add(value)
      })
      .and_then(|value| i64::try_from(value).ok())
      .ok_or_else(|| AuthError::InvalidInput("invalid speech job deadline".into()))?;
    Utc::now()
      .checked_add_signed(chrono::Duration::milliseconds(millis))
      .ok_or_else(|| AuthError::InvalidInput("invalid speech job deadline".into()))
  }
  fn lease(self, config: &TranscriptionExecutionConfig) -> u32 {
    config
      .request_timeout_ms
      .div_ceil(1000)
      .saturating_add(u64::from(self.dispatch_seconds))
      .min(u64::from(u32::MAX)) as u32
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredInput {
  key: String,
  index: usize,
  format: String,
  checksum: String,
  duration_seconds: f64,
}

pub struct TranscriptionPipeline {
  pub repository: Arc<dyn TranscriptionResultRepository>,
  blobs: Arc<BlobService>,
  permissions: Arc<PermissionService>,
  inspector: Arc<dyn AudioInputInspector>,
  queue: Arc<dyn WorkQueuePort>,
}

fn storage(error: impl std::fmt::Display) -> AuthError {
  AuthError::Storage(error.to_string())
}
fn speech(error: ProviderError) -> AuthError {
  AuthError::InvalidInput(error.to_string())
}
fn checksum(data: &[u8], deadline: Instant) -> AuthResult<String> {
  let mut hash = Sha256::new();
  for chunk in data.chunks(8192) {
    if Instant::now() >= deadline {
      return Err(speech(ProviderError::Timeout("audio input deadline exceeded".into())));
    }
    hash.update(chunk);
  }
  Ok(hex::encode(hash.finalize()))
}
fn payload_inputs(payload: &Value, field: &str) -> AuthResult<Vec<StoredInput>> {
  payload
    .get(field)
    .filter(|value| !value.is_null())
    .map(|value| {
      serde_json::from_value(value.clone()).map_err(|_| AuthError::InvalidInput("invalid durable audio input".into()))
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

impl TranscriptionPipeline {
  pub fn new(
    repository: Arc<dyn TranscriptionResultRepository>,
    blobs: Arc<BlobService>,
    permissions: Arc<PermissionService>,
    inspector: Arc<dyn AudioInputInspector>,
    queue: Arc<dyn WorkQueuePort>,
  ) -> Self {
    Self {
      repository,
      blobs,
      permissions,
      inspector,
      queue,
    }
  }

  pub async fn authorize(&self, user_id: Uuid, workspace_id: Uuid) -> AuthResult<()> {
    let resource = WorkspaceResource { user_id, workspace_id };
    self
      .permissions
      .assert(&resource, WorkspaceAction::Transcription)
      .await?;
    self.permissions.assert(&resource, WorkspaceAction::BlobsRead).await
  }

  async fn original(
    &self,
    workspace: Uuid,
    blob: &str,
    admission: &TranscriptionAdmission<'_>,
  ) -> AuthResult<(AudioInputInfo, String)> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(admission.deadline), async {
      let audio = self
        .blobs
        .get_blob_bounded(workspace, blob, admission.config.max_input_bytes)
        .await?
        .data;
      let digest = checksum(&audio, admission.deadline)?;
      let info = self
        .inspector
        .inspect(audio, admission.input_work())
        .await
        .map_err(speech)?;
      Ok((info, digest))
    })
    .await
    .unwrap_or_else(|_| Err(speech(ProviderError::Timeout("audio input deadline exceeded".into()))))
  }

  fn owned_input(job_id: Uuid, input: &StoredInput) -> AuthResult<()> {
    if !matches!(input.format.as_str(), "wav" | "mp4" | "ogg" | "webm" | "flac" | "mp3")
      || input.key != format!("transcription/{job_id}/{}.{}", input.index, input.format)
    {
      return Err(AuthError::InvalidInput("invalid durable audio input binding".into()));
    }
    Ok(())
  }

  #[instrument(skip_all)]
  pub async fn submit(
    &self,
    user: Uuid,
    workspace: Uuid,
    blob: &str,
    uploads: Vec<TranscriptionUpload>,
    service: Arc<TranscriptionService>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<CopilotJob> {
    self
      .submit_named(Uuid::new_v4(), user, workspace, blob, uploads, service, policy)
      .await
  }

  async fn submit_named(
    &self,
    job_id: Uuid,
    user: Uuid,
    workspace: Uuid,
    blob: &str,
    uploads: Vec<TranscriptionUpload>,
    service: Arc<TranscriptionService>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<CopilotJob> {
    let admission = service.admit_job(None).map_err(speech)?;
    self
      .submit_admitted(job_id, user, workspace, blob, uploads, &admission, policy)
      .await
  }

  async fn submit_admitted(
    &self,
    job_id: Uuid,
    user: Uuid,
    workspace: Uuid,
    blob: &str,
    uploads: Vec<TranscriptionUpload>,
    admission: &TranscriptionAdmission<'_>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<CopilotJob> {
    let key = BlobKey::parse(blob).map_err(AuthError::InvalidInput)?;
    let blob = key.as_str();
    self.authorize(user, workspace).await?;
    if let Some(existing) = self.repository.attempt(job_id).await.map_err(storage)? {
      if existing.job.user_id != Some(user)
        || existing.job.workspace_id != Some(workspace)
        || existing.job.payload["blobId"].as_str() != Some(blob)
      {
        return Err(AuthError::InvalidInput("audio job source binding differs".into()));
      }
      return Ok(existing.job);
    }
    let (original, original_checksum) = self.original(workspace, blob, admission).await?;
    let mut parts = Vec::new();
    let mut total_bytes = 0_u64;
    let mut total_duration = 0.0;
    for (index, upload) in uploads.iter().enumerate() {
      if uploads.len() > 1 {
        let suffix = upload
          .filename
          .rsplit_once('-')
          .and_then(|(_, tail)| tail.split_once('.'))
          .and_then(|(number, _)| number.parse::<usize>().ok());
        if suffix != Some(index) {
          return Err(AuthError::InvalidInput("audio slices are not in source order".into()));
        }
      }
      let audio = read_upload(
        &upload.file,
        admission.config.max_input_bytes.saturating_sub(total_bytes),
        admission.input_work(),
      )
      .await?;
      total_bytes = total_bytes
        .checked_add(audio.len() as u64)
        .ok_or_else(|| AuthError::InvalidInput("audio input exceeds the configured limit".into()))?;
      let digest = checksum(&audio, admission.deadline)?;
      let info = self
        .inspector
        .inspect(audio, admission.input_work())
        .await
        .map_err(speech)?;
      total_duration += info.duration_seconds;
      if total_duration > admission.config.max_duration_seconds as f64 {
        return Err(AuthError::InvalidInput(
          "audio duration exceeds the configured limit".into(),
        ));
      }
      parts.push(StoredInput {
        key: format!("transcription/{job_id}/{index}.{}", info.format),
        index,
        format: info.format,
        checksum: digest,
        duration_seconds: info.duration_seconds,
      });
    }
    // Container padding can differ after the deployed client's MP4 encoding.
    // A bounded tolerance never permits unrelated lengths or reorders slices.
    if !parts.is_empty() && (total_duration - original.duration_seconds).abs() > 0.1 * parts.len() as f64 {
      return Err(AuthError::InvalidInput(
        "audio slice duration does not match its attachment".into(),
      ));
    }
    let now = Utc::now();
    let mut job = self
      .repository
      .create_job(
        &CopilotJob {
          id: job_id,
          job_type: "audio_transcription".into(),
          state: CopilotJobState::Pending,
          workspace_id: Some(workspace),
          user_id: Some(user),
          payload: json!({"blobId":blob,"transcriptionConfig":admission.config,"sourceChecksum":original_checksum,
        "inputReady":parts.is_empty(),"inputs":parts,"temporaryInputs":parts}),
          error_message: None,
          created_at: now,
          updated_at: now,
        },
        policy.deadline(&admission.config)?,
      )
      .await
      .map_err(storage)?;
    let attempt = self
      .repository
      .attempt(job.id)
      .await
      .map_err(storage)?
      .ok_or_else(|| AuthError::NotFound("audio job".into()))?;
    if !parts.is_empty() {
      let preparation = async {
        for (upload, part) in uploads.iter().zip(&parts) {
          let audio = read_upload(&upload.file, admission.config.max_input_bytes, admission.input_work()).await?;
          if checksum(&audio, admission.deadline)? != part.checksum {
            return Err(AuthError::InvalidInput(
              "audio upload changed during preparation".into(),
            ));
          }
          self
            .blobs
            .upload_single_part_blob(
              workspace,
              &part.key,
              audio,
              mime(&part.format),
              Some(mime(&part.format).into()),
              Some(&part.checksum),
            )
            .await?;
        }
        self.authorize(user, workspace).await?;
        if !self
          .repository
          .finish_preparation(job.id, attempt.id)
          .await
          .map_err(storage)?
        {
          return Err(AuthError::InvalidInput("audio preparation expired".into()));
        }
        Ok::<(), AuthError>(())
      };
      let outcome = tokio::time::timeout_at(tokio::time::Instant::from_std(admission.deadline), preparation)
        .await
        .unwrap_or_else(|_| {
          Err(speech(ProviderError::Timeout(
            "audio preparation deadline exceeded".into(),
          )))
        });
      if let Err(error) = outcome {
        tracing::error!(job_id = %job.id, error = %error, "audio preparation failed");
        self
          .repository
          .abort_preparation(job.id, attempt.id, &error.to_string())
          .await
          .map_err(storage)?;
        job = self
          .repository
          .attempt(job.id)
          .await
          .map_err(storage)?
          .ok_or_else(|| AuthError::NotFound("audio job".into()))?
          .job;
        return Ok(job);
      }
    }
    self.dispatch(&attempt, policy).await;
    Ok(job)
  }

  #[instrument(skip_all)]
  pub async fn process_queued(
    &self,
    action: &str,
    queue_id: &str,
    data: &Value,
    service: Result<Arc<TranscriptionService>, ProviderError>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<()> {
    let uuid_field = |name: &str| {
      data[name]
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| AuthError::InvalidInput(format!("missing or invalid {name}")))
    };
    let workspace = uuid_field("workspaceId")?;
    if action == "bulkProcess" {
      let service = service.map_err(speech)?;
      // This is an explicitly initiated, server-internal queue action. A missing
      // actor is never repaired with a synthetic user or an automatic bulk run.
      let user = uuid_field("userId")?;
      self.authorize(user, workspace).await?;
      // Keep one admission through this bounded bulk preparation. Child workers
      // cannot consume its slots between items; duplicate deliveries reuse the
      // same durable child identities without creating another scheduler.
      let admission = service.admit_job(None).map_err(speech)?;
      for (blob, _) in self.blobs.list_workspace_audio_blobs(workspace).await? {
        if blob.starts_with("transcription/") {
          continue;
        }
        let identity = serde_json::to_vec(&(queue_id, user, workspace, &blob)).map_err(storage)?;
        // Stable child identities make a repeated bulk delivery idempotent.
        self
          .submit_admitted(
            Uuid::new_v5(&workspace, &identity),
            user,
            workspace,
            &blob,
            Vec::new(),
            &admission,
            policy,
          )
          .await?;
      }
      return Ok(());
    }
    let job_id = data["copilotJobId"]
      .as_str()
      .or_else(|| data["jobId"].as_str())
      .and_then(|value| Uuid::parse_str(value).ok())
      .ok_or_else(|| AuthError::InvalidInput("missing audio job identity".into()))?;
    let prior = self
      .repository
      .attempt(job_id)
      .await
      .map_err(storage)?
      .ok_or_else(|| AuthError::NotFound("audio job".into()))?;
    let user = prior
      .job
      .user_id
      .ok_or_else(|| AuthError::InvalidInput("missing initiating audio authority".into()))?;
    if prior.job.workspace_id != Some(workspace)
      || data["userId"].as_str().is_some_and(|value| value != user.to_string())
      || data["blobKey"]
        .as_str()
        .is_some_and(|value| prior.job.payload["blobId"].as_str() != Some(value))
    {
      return Err(AuthError::InvalidInput("audio queue source binding differs".into()));
    }
    match action {
      "generate" => {
        let nonce = data.get("attemptId").map(|_| uuid_field("attemptId")).transpose()?;
        self.process(job_id, nonce, service.map_err(speech)?, policy).await
      }
      "refresh" => {
        self
          .retry(user, workspace, job_id, service.map_err(speech)?, policy)
          .await
      }
      "delete" => {
        self.authorize(user, workspace).await?;
        self.repository.delete_result(job_id, workspace).await.map_err(storage)
      }
      _ => Err(AuthError::InvalidInput("unknown audio queue action".into())),
    }
  }

  #[instrument(skip_all)]
  pub async fn retry(
    &self,
    user: Uuid,
    workspace: Uuid,
    job_id: Uuid,
    service: Arc<TranscriptionService>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<()> {
    self.authorize(user, workspace).await?;
    let prior = self
      .repository
      .attempt(job_id)
      .await
      .map_err(storage)?
      .filter(|attempt| attempt.job.user_id == Some(user) && attempt.job.workspace_id == Some(workspace))
      .ok_or_else(|| AuthError::NotFound("audio job".into()))?;
    let admission = service.admit_job(None).map_err(speech)?;
    if matches!(
      prior.job.state,
      CopilotJobState::Pending | CopilotJobState::Running | CopilotJobState::Claimed
    ) && (prior.job.payload["inputReady"] == Value::Bool(false)
      || prior.job.payload["transcriptionConfig"] == serde_json::to_value(&admission.config).map_err(storage)?)
    {
      return Ok(());
    }
    let blob = prior.job.payload["blobId"]
      .as_str()
      .ok_or_else(|| AuthError::InvalidInput("missing audio attachment binding".into()))?;
    let (_, digest) = self.original(workspace, blob, &admission).await?;
    let mut payload = prior.job.payload.clone();
    payload["transcriptionConfig"] = serde_json::to_value(&admission.config).map_err(storage)?;
    payload["sourceChecksum"] = json!(digest);
    payload["inputs"] = Value::Null;
    payload["inputReady"] = Value::Bool(true);
    // The CAS invalidates the old worker before any cleanup can delete its
    // derived inputs. Explicit retry always recreates input from the original.
    if let Some(current) = self
      .repository
      .retry_attempt(&prior, payload, policy.deadline(&admission.config)?)
      .await
      .map_err(storage)?
    {
      self.dispatch(&current, policy).await;
    }
    Ok(())
  }

  async fn dispatch(&self, attempt: &AudioJobAttempt, policy: TranscriptionJobPolicy) {
    let data = json!({"copilotJobId":attempt.job.id,"attemptId":attempt.id,
      "workspaceId":attempt.job.workspace_id,"userId":attempt.job.user_id,"blobKey":attempt.job.payload["blobId"]});
    if let Err(error) = self
      .queue
      .add_job(
        "copilot",
        "copilot.transcript.generate",
        data,
        Some(policy.max_attempts),
        None,
      )
      .await
    {
      tracing::warn!(job_id = %attempt.job.id, error = %error, "audio dispatch failed; durable job remains recoverable");
    }
  }

  #[instrument(skip_all)]
  pub async fn recover(&self, policy: TranscriptionJobPolicy) -> AuthResult<()> {
    for attempt in self
      .repository
      .cleanup_due(policy.dispatch_seconds)
      .await
      .map_err(storage)?
    {
      if let Err(error) = self.cleanup(&attempt).await {
        tracing::warn!(job_id = %attempt.job.id, error = %error, "audio temporary input cleanup failed");
      }
    }
    for attempt in self
      .repository
      .recover(policy.max_attempts, policy.dispatch_seconds)
      .await
      .map_err(storage)?
    {
      self.dispatch(&attempt, policy).await;
    }
    Ok(())
  }

  async fn cleanup(&self, attempt: &AudioJobAttempt) -> AuthResult<()> {
    let workspace = attempt
      .job
      .workspace_id
      .ok_or_else(|| AuthError::InvalidInput("missing audio workspace binding".into()))?;
    for input in payload_inputs(&attempt.job.payload, "temporaryInputs")? {
      Self::owned_input(attempt.job.id, &input)?;
      if attempt.job.payload["blobId"].as_str() == Some(&input.key) {
        return Err(AuthError::InvalidInput(
          "temporary audio input is the original attachment".into(),
        ));
      }
      self.blobs.hard_delete_blob(workspace, &input.key).await?;
    }
    self
      .repository
      .finish_cleanup(attempt.job.id, attempt.id)
      .await
      .map_err(storage)?;
    Ok(())
  }

  #[instrument(skip_all)]
  pub async fn process(
    &self,
    job_id: Uuid,
    queued_attempt: Option<Uuid>,
    service: Arc<TranscriptionService>,
    policy: TranscriptionJobPolicy,
  ) -> AuthResult<()> {
    let Some(prior) = self.repository.attempt(job_id).await.map_err(storage)? else {
      return Err(AuthError::NotFound("audio job".into()));
    };
    if prior.job.state != CopilotJobState::Pending || queued_attempt.is_some_and(|id| id != prior.id) {
      return Ok(());
    }
    let snapshot: TranscriptionExecutionConfig =
      serde_json::from_value(prior.job.payload["transcriptionConfig"].clone())
        .map_err(|_| AuthError::InvalidInput("invalid durable transcription execution snapshot".into()))?;
    let mut admission_failure = None;
    let admission = match service.admit_job(Some(&snapshot)) {
      Ok(admission) => Some(admission),
      Err(ProviderError::RateLimited(_)) => return Ok(()),
      Err(error) => {
        admission_failure = Some(error.to_string());
        None
      }
    };
    let Some(attempt) = self
      .repository
      .claim_attempt(job_id, prior.id, policy.lease(&snapshot))
      .await
      .map_err(storage)?
    else {
      return Ok(());
    };
    let workspace = attempt
      .job
      .workspace_id
      .ok_or_else(|| AuthError::InvalidInput("missing audio workspace binding".into()))?;
    let user = attempt
      .job
      .user_id
      .ok_or_else(|| AuthError::InvalidInput("missing initiating audio authority".into()))?;
    let blob = attempt.job.payload["blobId"]
      .as_str()
      .ok_or_else(|| AuthError::InvalidInput("missing audio attachment binding".into()))?;
    let outcome = async {
      self.authorize(user, workspace).await?;
      let admission = admission.as_ref().ok_or_else(|| {
        AuthError::InvalidInput(admission_failure.unwrap_or_else(|| "transcription is unavailable".into()))
      })?;
      let (original, digest) = self.original(workspace, blob, admission).await?;
      if attempt.job.payload["sourceChecksum"]
        .as_str()
        .is_some_and(|expected| expected != digest)
      {
        return Err(AuthError::InvalidInput(
          "audio attachment changed since submission".into(),
        ));
      }
      let parts = payload_inputs(&attempt.job.payload, "inputs")?;
      let mut merged = TranscriptionResponse {
        text: String::new(),
        language: None,
        duration_seconds: Some(original.duration_seconds),
        segments: Vec::new(),
      };
      let mut offset = 0.0;
      let mut total_bytes = 0_u64;
      let mut output_bytes = 0_usize;
      if parts.is_empty() {
        let audio = self
          .blobs
          .get_blob_bounded(workspace, blob, admission.config.max_input_bytes)
          .await?
          .data;
        if checksum(&audio, admission.deadline)? != digest {
          return Err(AuthError::InvalidInput("audio attachment changed during read".into()));
        }
        merged = admission.transcribe(&audio, &original.format).await.map_err(speech)?;
      } else {
        for (index, part) in parts.iter().enumerate() {
          Self::owned_input(job_id, part)?;
          if part.index != index {
            return Err(AuthError::InvalidInput("audio slices are not in source order".into()));
          }
          let audio = self
            .blobs
            .get_blob_bounded(
              workspace,
              &part.key,
              admission.config.max_input_bytes.saturating_sub(total_bytes),
            )
            .await?
            .data;
          total_bytes = total_bytes
            .checked_add(audio.len() as u64)
            .ok_or_else(|| AuthError::InvalidInput("audio exceeds the configured input limit".into()))?;
          if checksum(&audio, admission.deadline)? != part.checksum {
            return Err(AuthError::InvalidInput("durable audio input changed".into()));
          }
          let info = self
            .inspector
            .inspect(audio.clone(), admission.input_work())
            .await
            .map_err(speech)?;
          if info.format != part.format || (info.duration_seconds - part.duration_seconds).abs() > 0.001 {
            return Err(AuthError::InvalidInput("durable audio input changed".into()));
          }
          if offset + info.duration_seconds > admission.config.max_duration_seconds as f64 {
            return Err(AuthError::InvalidInput(
              "audio duration exceeds the configured limit".into(),
            ));
          }
          let remaining_output = admission.config.max_response_bytes.saturating_sub(output_bytes);
          let response = admission
            .transcribe_bounded(&audio, &info.format, remaining_output)
            .await
            .map_err(speech)?;
          output_bytes = output_bytes
            .checked_add(serde_json::to_vec(&response).map_err(storage)?.len())
            .filter(|value| *value <= admission.config.max_response_bytes)
            .ok_or_else(|| AuthError::InvalidInput("speech output exceeds the configured limit".into()))?;
          if !merged.text.is_empty() && !response.text.is_empty() {
            merged.text.push('\n');
          }
          merged.text.push_str(&response.text);
          merged.language = merged.language.or(response.language);
          merged.segments.extend(response.segments.into_iter().map(|mut segment| {
            segment.start_seconds = segment.start_seconds.map(|value| value + offset);
            segment.end_seconds = segment.end_seconds.map(|value| value + offset);
            segment
          }));
          offset += info.duration_seconds;
        }
      }
      if serde_json::to_vec(&merged).map_err(storage)?.len() > admission.config.max_response_bytes {
        return Err(AuthError::InvalidInput(
          "speech output exceeds the configured limit".into(),
        ));
      }
      if merged.text.trim().is_empty() {
        return Err(AuthError::InvalidInput("no speech was recognized".into()));
      }
      self.authorize(user, workspace).await?;
      self
        .repository
        .complete(job_id, workspace, blob, &snapshot.model, &merged, attempt.id)
        .await
        .map_err(storage)?;
      Ok::<(), AuthError>(())
    };
    let deadline = admission
      .as_ref()
      .map(|value| value.deadline)
      .unwrap_or_else(|| Instant::now() + std::time::Duration::from_millis(snapshot.request_timeout_ms));
    let outcome = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), outcome)
      .await
      .unwrap_or_else(|_| {
        Err(speech(ProviderError::Timeout(
          "speech request deadline exceeded".into(),
        )))
      });
    if let Some(admission) = admission.as_ref() {
      admission.record_job_result(outcome.is_ok()).await;
    }
    if let Err(error) = outcome {
      tracing::error!(job_id = %job_id, error = %error, "audio transcription failed");
      self
        .repository
        .fail(
          job_id,
          workspace,
          blob,
          &error.to_string(),
          attempt.id,
          policy.max_attempts,
        )
        .await
        .map_err(storage)?;
    }
    Ok(())
  }
}

fn mime(format: &str) -> &'static str {
  match format {
    "wav" => "audio/wav",
    "mp4" => "audio/mp4",
    "ogg" => "audio/ogg",
    "webm" => "audio/webm",
    "flac" => "audio/flac",
    _ => "audio/mpeg",
  }
}

async fn read_upload(file: &File, max_bytes: u64, work: AudioInputWork) -> AuthResult<Bytes> {
  let mut file = file
    .try_clone()
    .map_err(|_| AuthError::InvalidInput("could not read audio upload".into()))?;
  tokio::task::spawn_blocking(move || {
    let deadline = work.deadline;
    let _work = work;
    let size = file
      .metadata()
      .map_err(|_| AuthError::InvalidInput("could not read audio upload".into()))?
      .len();
    if size == 0 || size > max_bytes {
      return Err(AuthError::InvalidInput(
        "audio upload is empty or exceeds the configured input limit".into(),
      ));
    }
    file
      .seek(SeekFrom::Start(0))
      .map_err(|_| AuthError::InvalidInput("could not read audio upload".into()))?;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
      if Instant::now() >= deadline {
        return Err(speech(ProviderError::Timeout(
          "audio preparation deadline exceeded".into(),
        )));
      }
      let count = file
        .read(&mut chunk)
        .map_err(|_| AuthError::InvalidInput("could not read audio upload".into()))?;
      if count == 0 {
        break;
      }
      if bytes.len() as u64 + count as u64 > max_bytes {
        return Err(AuthError::InvalidInput(
          "audio upload exceeds the configured input limit".into(),
        ));
      }
      bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 != size {
      return Err(AuthError::InvalidInput("audio upload changed during read".into()));
    }
    Ok(Bytes::from(bytes))
  })
  .await
  .map_err(|_| AuthError::InvalidInput("could not read audio upload".into()))?
}
