// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical audio result persistence and conjunctive owner/source readback.

use async_trait::async_trait;
use myoxus_domain::{
  entities::{CopilotJob, CopilotJobState},
  repositories::{RepoResult, RepositoryError},
  transcription::{
    AudioJobAttempt, AudioJobResult, StoredTranscription, TranscriptionResponse, TranscriptionResultQuery,
    TranscriptionResultRepository, TranscriptionSegment,
  },
};
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgRow};
use tracing::instrument;
use uuid::Uuid;

pub struct PgTranscriptionResultRepository {
  pool: PgPool,
}
impl PgTranscriptionResultRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

fn db_error(error: sqlx::Error) -> RepositoryError {
  tracing::error!(error = %error, "transcription repository database error");
  RepositoryError::Storage(error.to_string())
}

fn job(row: &PgRow) -> RepoResult<CopilotJob> {
  let state = match row.get::<String, _>("state").as_str() {
    "pending" => CopilotJobState::Pending,
    "claimed" => CopilotJobState::Claimed,
    "running" => CopilotJobState::Running,
    "finished" => CopilotJobState::Finished,
    "failed" => CopilotJobState::Failed,
    _ => return Err(RepositoryError::Storage("invalid audio job state".into())),
  };
  Ok(CopilotJob {
    id: row.get("id"),
    job_type: row.get("job_type"),
    state,
    workspace_id: row.get("workspace_id"),
    user_id: row.get("user_id"),
    payload: row.get("payload"),
    error_message: row.get("error_message"),
    created_at: row.get("created_at"),
    updated_at: row.get("updated_at"),
  })
}

fn seconds(value: Option<&Value>) -> Option<f64> {
  let value = value?;
  let number = if let Some(number) = value.as_f64() {
    number
  } else if let Some(text) = value.as_str() {
    match text.parse::<f64>() {
      Ok(number) => number,
      Err(_) => return None,
    }
  } else {
    return None;
  };
  number.is_finite().then_some(number)
}

fn attempt(row: &PgRow) -> RepoResult<AudioJobAttempt> {
  Ok(AudioJobAttempt {
    job: job(row)?,
    id: row
      .get::<Option<Uuid>, _>("transcription_attempt_id")
      .ok_or(RepositoryError::NotFound("audio_attempt"))?,
    attempts: row.get::<i32, _>("transcription_attempts") as u32,
    deadline: row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("transcription_deadline")
      .unwrap_or_else(|| row.get("created_at")),
  })
}

/// Deployed rows contain both provider `start`/`end` and transport
/// `start_seconds`/`end_seconds`. Missing metadata never discards their text.
fn segments(value: Value) -> Vec<TranscriptionSegment> {
  let Some(values) = value.as_array() else {
    return Vec::new();
  };
  values
    .iter()
    .filter_map(|segment| {
      let text = segment.get("text").or_else(|| segment.get("transcription"))?.as_str()?;
      Some(TranscriptionSegment {
        text: text.into(),
        start_seconds: seconds(segment.get("start_seconds").or_else(|| segment.get("start"))),
        end_seconds: seconds(segment.get("end_seconds").or_else(|| segment.get("end"))),
        speaker: segment.get("speaker").and_then(Value::as_str).map(str::to_owned),
      })
    })
    .collect()
}

#[async_trait]
impl TranscriptionResultRepository for PgTranscriptionResultRepository {
  #[instrument(skip_all)]
  async fn enrichment(&self, source: &AudioJobResult) -> RepoResult<Option<CopilotJob>> {
    let Some(transcript) = &source.transcript else {
      return Ok(None);
    };
    // A killed request/server needs no automatic LLM replay. Readback exposes
    // the expired attempt as a local failure; another explicit action can retry.
    sqlx::query("UPDATE copilot_jobs SET state = 'failed', error_message = 'Enrichment request interrupted or timed out', updated_at = now() WHERE job_type = 'audio_enrichment' AND workspace_id = $1 AND user_id = $2 AND payload->>'sourceJobId' = $3 AND payload->>'transcriptId' = $4 AND payload->>'sourceRevision' = $6 AND state = 'running' AND (payload->>'deadline')::bigint <= $5")
      .bind(source.job.workspace_id).bind(source.job.user_id).bind(source.job.id.to_string()).bind(transcript.id.to_string()).bind(chrono::Utc::now().timestamp_millis()).bind(source.job.updated_at.to_rfc3339())
      .execute(&self.pool).await.map_err(db_error)?;
    sqlx::query("SELECT * FROM copilot_jobs WHERE job_type = 'audio_enrichment' AND workspace_id = $1 AND user_id = $2 AND payload->>'sourceJobId' = $3 AND payload->>'transcriptId' = $4 AND payload->>'sourceRevision' = $5 ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(source.job.workspace_id).bind(source.job.user_id).bind(source.job.id.to_string()).bind(transcript.id.to_string()).bind(source.job.updated_at.to_rfc3339())
      .fetch_optional(&self.pool).await.map_err(db_error)?.as_ref().map(job).transpose()
  }

  #[instrument(skip_all)]
  async fn begin_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool> {
    let transcript = source
      .transcript
      .as_ref()
      .ok_or(RepositoryError::NotFound("transcript"))?;
    let mut transaction = self.pool.begin().await.map_err(db_error)?;
    // Source-row locking deduplicates competing explicit requests across server
    // instances and serializes admission with speech refresh/deletion.
    let current = sqlx::query_scalar::<_, Uuid>("SELECT id FROM copilot_jobs WHERE id = $1 AND state = 'finished' AND transcription_result_id = $2 AND workspace_id = $3 AND user_id = $4 AND updated_at = $5 FOR UPDATE")
      .bind(source.job.id).bind(transcript.id).bind(source.job.workspace_id).bind(source.job.user_id).bind(source.job.updated_at)
      .fetch_optional(&mut *transaction).await.map_err(db_error)?;
    if current.is_none() {
      return Err(RepositoryError::NotFound("completed transcript"));
    }
    let running = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM copilot_jobs WHERE job_type = 'audio_enrichment' AND workspace_id = $1 AND user_id = $2 AND payload->>'sourceJobId' = $3 AND payload->>'transcriptId' = $4 AND payload->>'sourceRevision' = $6 AND state = 'running' AND (payload->>'deadline')::bigint > $5)")
      .bind(source.job.workspace_id).bind(source.job.user_id).bind(source.job.id.to_string()).bind(transcript.id.to_string()).bind(chrono::Utc::now().timestamp_millis()).bind(source.job.updated_at.to_rfc3339())
      .fetch_one(&mut *transaction).await.map_err(db_error)?;
    if running {
      transaction.commit().await.map_err(db_error)?;
      return Ok(false);
    }
    let affected = sqlx::query("INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload, created_at, updated_at) SELECT $1, 'audio_enrichment', 'running', workspace_id, user_id, $2, $3, $3 FROM copilot_jobs WHERE id = $4 AND job_type = 'audio_transcription' AND state = 'finished' AND transcription_result_id = $5 AND workspace_id = $6 AND user_id = $7")
      .bind(job.id).bind(&job.payload).bind(job.created_at).bind(source.job.id).bind(transcript.id).bind(source.job.workspace_id).bind(source.job.user_id)
      .execute(&mut *transaction).await.map_err(db_error)?.rows_affected();
    if affected != 1 {
      return Err(RepositoryError::NotFound("completed transcript"));
    }
    transaction.commit().await.map_err(db_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  async fn finish_enrichment(&self, source: &AudioJobResult, job: &CopilotJob) -> RepoResult<bool> {
    let transcript = source
      .transcript
      .as_ref()
      .ok_or(RepositoryError::NotFound("transcript"))?;
    let state = if job.state == CopilotJobState::Finished {
      "finished"
    } else {
      "failed"
    };
    let affected = sqlx::query("UPDATE copilot_jobs e SET state = $2, payload = $3, error_message = $4, updated_at = now() FROM copilot_jobs s WHERE e.id = $1 AND e.job_type = 'audio_enrichment' AND e.state = 'running' AND (e.payload->>'deadline')::bigint > $5 AND s.id = $6 AND s.job_type = 'audio_transcription' AND s.transcription_result_id = $7 AND s.workspace_id = e.workspace_id AND s.user_id = e.user_id AND s.state = 'finished' AND s.updated_at = $8")
      .bind(job.id).bind(state).bind(&job.payload).bind(&job.error_message).bind(chrono::Utc::now().timestamp_millis()).bind(source.job.id).bind(transcript.id).bind(source.job.updated_at)
      .execute(&self.pool).await.map_err(db_error)?.rows_affected();
    Ok(affected == 1)
  }

  #[instrument(skip_all)]
  async fn query(&self, query: &TranscriptionResultQuery) -> RepoResult<Vec<AudioJobResult>> {
    let rows = sqlx::query(
      r#"
      SELECT j.id, j.job_type, j.state, j.workspace_id, j.user_id, j.payload,
        j.error_message, j.created_at, j.updated_at, t.id AS result_id,
        t.content, t.segments, t.model, t.language, t.duration_secs, t.metadata
      FROM copilot_jobs j LEFT JOIN copilot_transcripts t ON t.id = j.transcription_result_id
        AND t.workspace_id = j.workspace_id AND t.source_type = 'audio' AND t.status = 'completed'
        AND (t.source_id = j.id::text OR t.source_id = j.payload->>'blobId')
      WHERE j.job_type = 'audio_transcription' AND j.user_id = $1
        AND ($2::uuid IS NULL OR j.workspace_id = $2)
        AND ($3::uuid IS NULL OR j.id = $3)
        AND ($4::text IS NULL OR j.payload->>'blobId' = $4)
      ORDER BY j.updated_at DESC, j.id DESC LIMIT 50
    "#,
    )
    .bind(query.user_id)
    .bind(query.workspace_id)
    .bind(query.job_id)
    .bind(query.blob_id.as_deref())
    .fetch_all(&self.pool)
    .await
    .map_err(db_error)?;
    rows
      .into_iter()
      .map(|row| {
        let transcript = row.get::<Option<Uuid>, _>("result_id").map(|id| {
          let metadata = row.get::<Option<Value>, _>("metadata").unwrap_or_default();
          StoredTranscription {
            id,
            model: row.get("model"),
            response: TranscriptionResponse {
              text: row.get("content"),
              segments: segments(row.get::<Option<Value>, _>("segments").unwrap_or_default()),
              language: row.get("language"),
              duration_seconds: row.get::<Option<f32>, _>("duration_secs").map(f64::from),
            },
            title: metadata.get("title").and_then(Value::as_str).map(str::to_owned),
            summary: metadata.get("summary").and_then(Value::as_str).map(str::to_owned),
            actions: metadata
              .get("action_items")
              .or_else(|| metadata.get("actions"))
              .and_then(Value::as_str)
              .map(str::to_owned),
          }
        });
        Ok(AudioJobResult {
          job: job(&row)?,
          transcript,
        })
      })
      .collect()
  }

  #[instrument(skip_all)]
  async fn create_job(&self, job: &CopilotJob, deadline: chrono::DateTime<chrono::Utc>) -> RepoResult<CopilotJob> {
    if job.job_type != "audio_transcription" || job.user_id.is_none() || job.workspace_id.is_none() {
      return Err(RepositoryError::Storage("expected an audio job".into()));
    }
    sqlx::query("INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload, error_message, created_at, updated_at, transcription_attempt_id, transcription_deadline, transcription_dispatch_after) VALUES ($1, 'audio_transcription', 'pending', $2, $3, $4, NULL, $5, $6, gen_random_uuid(), $7, now())")
      .bind(job.id).bind(job.workspace_id).bind(job.user_id).bind(&job.payload).bind(job.created_at).bind(job.updated_at)
      .bind(deadline)
      .execute(&self.pool).await.map_err(db_error)?;
    Ok(job.clone())
  }

  #[instrument(skip_all)]
  async fn attempt(&self, job_id: Uuid) -> RepoResult<Option<AudioJobAttempt>> {
    sqlx::query("SELECT * FROM copilot_jobs WHERE id = $1 AND job_type = 'audio_transcription'")
      .bind(job_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(db_error)?
      .as_ref()
      .map(attempt)
      .transpose()
  }

  #[instrument(skip_all)]
  async fn claim_attempt(
    &self,
    job_id: Uuid,
    attempt_id: Uuid,
    lease_seconds: u32,
  ) -> RepoResult<Option<AudioJobAttempt>> {
    sqlx::query("UPDATE copilot_jobs SET state = 'running', transcription_attempts = transcription_attempts + 1, transcription_lease_until = LEAST(transcription_deadline, now() + $3 * interval '1 second'), updated_at = now() WHERE id = $1 AND job_type = 'audio_transcription' AND transcription_attempt_id = $2 AND state = 'pending' AND COALESCE(payload->>'inputReady', 'true') = 'true' AND transcription_deadline > now() RETURNING *")
      .bind(job_id).bind(attempt_id).bind(i64::from(lease_seconds)).fetch_optional(&self.pool).await.map_err(db_error)?
      .as_ref().map(attempt).transpose()
  }

  #[instrument(skip_all)]
  async fn retry_attempt(
    &self,
    prior: &AudioJobAttempt,
    payload: Value,
    deadline: chrono::DateTime<chrono::Utc>,
  ) -> RepoResult<Option<AudioJobAttempt>> {
    sqlx::query("UPDATE copilot_jobs SET state = 'pending', payload = $5, error_message = NULL, transcription_attempt_id = gen_random_uuid(), transcription_attempts = 0, transcription_deadline = $6, transcription_lease_until = NULL, transcription_dispatch_after = now(), transcription_cleanup_after = now(), updated_at = now() WHERE id = $1 AND job_type = 'audio_transcription' AND workspace_id = $2 AND user_id = $3 AND transcription_attempt_id = $4 RETURNING *")
      .bind(prior.job.id).bind(prior.job.workspace_id).bind(prior.job.user_id).bind(prior.id).bind(payload).bind(deadline)
      .fetch_optional(&self.pool).await.map_err(db_error)?.as_ref().map(attempt).transpose()
  }

  #[instrument(skip_all)]
  async fn recover(&self, max_attempts: u32, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>> {
    let mut transaction = self.pool.begin().await.map_err(db_error)?;
    // Initialize only deployed jobs lacking a deadline. The execution snapshot
    // and existing worker policy supply a one-time upgrade window. Creation
    // age alone cannot invalidate otherwise valid deployed queue work.
    sqlx::query(
      r#"
      WITH picked AS (
        SELECT id FROM copilot_jobs WHERE job_type = 'audio_transcription'
          AND state IN ('pending','running','claimed') AND transcription_deadline IS NULL
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 50
      ) UPDATE copilot_jobs j SET transcription_deadline = now() +
        ((CASE WHEN j.payload #>> '{transcriptionConfig,request_timeout_ms}' ~ '^[0-9]{1,9}$'
          THEN LEAST((j.payload #>> '{transcriptionConfig,request_timeout_ms}')::bigint, 3600000) / 1000.0 ELSE 0 END)
          * ($1 + 1) + $2 * $1) * interval '1 second',
        transcription_lease_until = CASE WHEN j.state IN ('running','claimed') THEN now() ELSE NULL END,
        transcription_attempt_id = COALESCE(j.transcription_attempt_id, gen_random_uuid()),
        transcription_dispatch_after = COALESCE(j.transcription_dispatch_after, now())
      FROM picked WHERE j.id = picked.id
    "#,
    )
    .bind(i64::from(max_attempts))
    .bind(i64::from(dispatch_seconds))
    .execute(&mut *transaction)
    .await
    .map_err(db_error)?;
    sqlx::query(r#"
      WITH picked AS (
        SELECT id FROM copilot_jobs WHERE job_type = 'audio_transcription'
          AND state IN ('pending','running','claimed')
          AND (transcription_deadline <= now() OR (state IN ('running','claimed') AND transcription_lease_until <= now()))
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 50
      ) UPDATE copilot_jobs j SET
        state = CASE WHEN j.transcription_deadline <= now() OR j.transcription_attempts >= $1 THEN 'failed' ELSE 'pending' END,
        error_message = CASE WHEN j.transcription_deadline <= now() THEN 'speech job deadline exceeded' ELSE 'speech attempt interrupted' END,
        transcription_attempt_id = gen_random_uuid(), transcription_lease_until = NULL,
        transcription_dispatch_after = now(),
        transcription_cleanup_after = CASE WHEN j.transcription_deadline <= now() OR j.transcription_attempts >= $1 THEN now() ELSE j.transcription_cleanup_after END,
        updated_at = now()
      FROM picked WHERE j.id = picked.id
    "#).bind(i64::from(max_attempts)).execute(&mut *transaction).await.map_err(db_error)?;
    let rows = sqlx::query(
      r#"
      WITH picked AS (
        SELECT id FROM copilot_jobs WHERE job_type = 'audio_transcription' AND state = 'pending'
          AND transcription_deadline > now() AND transcription_dispatch_after <= now()
          AND COALESCE(payload->>'inputReady', 'true') = 'true'
        ORDER BY transcription_dispatch_after, created_at, id FOR UPDATE SKIP LOCKED LIMIT 50
      ) UPDATE copilot_jobs j SET transcription_dispatch_after = now() + $1 * interval '1 second'
      FROM picked WHERE j.id = picked.id RETURNING j.*
    "#,
    )
    .bind(i64::from(dispatch_seconds))
    .fetch_all(&mut *transaction)
    .await
    .map_err(db_error)?;
    let attempts = rows.iter().map(attempt).collect::<RepoResult<Vec<_>>>()?;
    transaction.commit().await.map_err(db_error)?;
    Ok(attempts)
  }

  #[instrument(skip_all)]
  async fn finish_preparation(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool> {
    let updated = sqlx::query("UPDATE copilot_jobs SET payload = jsonb_set(payload, '{inputReady}', 'true'::jsonb), updated_at = now() WHERE id = $1 AND job_type = 'audio_transcription' AND transcription_attempt_id = $2 AND state = 'pending' AND transcription_deadline > now()")
      .bind(job_id).bind(attempt_id).execute(&self.pool).await.map_err(db_error)?;
    Ok(updated.rows_affected() == 1)
  }

  #[instrument(skip_all)]
  async fn abort_preparation(&self, job_id: Uuid, attempt_id: Uuid, error: &str) -> RepoResult<bool> {
    let updated = sqlx::query("UPDATE copilot_jobs SET state = 'failed', error_message = $3, transcription_attempt_id = gen_random_uuid(), transcription_cleanup_after = now(), updated_at = now() WHERE id = $1 AND job_type = 'audio_transcription' AND transcription_attempt_id = $2 AND state = 'pending' AND payload->>'inputReady' = 'false'")
      .bind(job_id).bind(attempt_id).bind(error).execute(&self.pool).await.map_err(db_error)?;
    Ok(updated.rows_affected() == 1)
  }

  #[instrument(skip_all)]
  async fn cleanup_due(&self, dispatch_seconds: u32) -> RepoResult<Vec<AudioJobAttempt>> {
    let rows = sqlx::query("WITH picked AS (SELECT id FROM copilot_jobs WHERE job_type = 'audio_transcription' AND transcription_cleanup_after <= now() ORDER BY transcription_cleanup_after, id FOR UPDATE SKIP LOCKED LIMIT 50) UPDATE copilot_jobs j SET transcription_cleanup_after = now() + $1 * interval '1 second' FROM picked WHERE j.id = picked.id RETURNING j.*")
      .bind(i64::from(dispatch_seconds)).fetch_all(&self.pool).await.map_err(db_error)?;
    rows.iter().map(attempt).collect()
  }

  #[instrument(skip_all)]
  async fn finish_cleanup(&self, job_id: Uuid, attempt_id: Uuid) -> RepoResult<bool> {
    let updated = sqlx::query("UPDATE copilot_jobs SET payload = payload - 'temporaryInputs', transcription_cleanup_after = NULL WHERE id = $1 AND job_type = 'audio_transcription' AND transcription_attempt_id = $2")
      .bind(job_id).bind(attempt_id).execute(&self.pool).await.map_err(db_error)?;
    Ok(updated.rows_affected() == 1)
  }

  #[instrument(skip_all)]
  async fn complete(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    model: &str,
    response: &TranscriptionResponse,
    attempt_id: Uuid,
  ) -> RepoResult<bool> {
    let mut transaction = self.pool.begin().await.map_err(db_error)?;
    let owner = sqlx::query("SELECT transcription_attempt_id, state, transcription_deadline FROM copilot_jobs WHERE id = $1 AND workspace_id = $2 AND job_type = 'audio_transcription' AND payload->>'blobId' = $3 FOR UPDATE")
      .bind(job_id).bind(workspace_id).bind(blob_id).fetch_optional(&mut *transaction).await.map_err(db_error)?;
    let owner = owner.ok_or(RepositoryError::NotFound("audio_job"))?;
    if owner.get::<Option<Uuid>, _>("transcription_attempt_id") != Some(attempt_id)
      || owner.get::<String, _>("state") != "running"
      || owner
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("transcription_deadline")
        .is_none_or(|value| value <= chrono::Utc::now())
    {
      return Ok(false);
    }
    let segment_values =
      serde_json::to_value(&response.segments).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let result_id: Uuid = sqlx::query_scalar(r#"
      INSERT INTO copilot_transcripts (workspace_id, source_type, source_id, content, segments, model, language, duration_secs, status)
      VALUES ($1, 'audio', $2, $3, $4, $5, $6, $7, 'completed')
      ON CONFLICT (workspace_id, source_type, source_id, model) DO UPDATE SET
        content = EXCLUDED.content, segments = EXCLUDED.segments, language = EXCLUDED.language,
        duration_secs = EXCLUDED.duration_secs, status = 'completed', error_message = NULL, updated_at = now()
      RETURNING id
    "#).bind(workspace_id).bind(job_id.to_string()).bind(&response.text).bind(segment_values).bind(model)
      .bind(&response.language).bind(response.duration_seconds.map(|duration| duration as f32))
      .fetch_one(&mut *transaction).await.map_err(db_error)?;
    // Historical payloads are recovery-only. Never update them with new content.
    sqlx::query("UPDATE copilot_jobs SET transcription_result_id = $2, state = 'finished', error_message = NULL, transcription_lease_until = NULL, transcription_cleanup_after = now(), updated_at = now() WHERE id = $1")
      .bind(job_id).bind(result_id).execute(&mut *transaction).await.map_err(db_error)?;
    transaction.commit().await.map_err(db_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  async fn fail(
    &self,
    job_id: Uuid,
    workspace_id: Uuid,
    blob_id: &str,
    error: &str,
    attempt_id: Uuid,
    max_attempts: u32,
  ) -> RepoResult<bool> {
    let update = sqlx::query("UPDATE copilot_jobs SET state = CASE WHEN transcription_attempts < $6 AND transcription_deadline > now() THEN 'pending' ELSE 'failed' END, error_message = $4, transcription_attempt_id = gen_random_uuid(), transcription_lease_until = NULL, transcription_dispatch_after = now(), transcription_cleanup_after = CASE WHEN transcription_attempts < $6 AND transcription_deadline > now() THEN transcription_cleanup_after ELSE now() END, updated_at = now() WHERE id = $1 AND workspace_id = $2 AND job_type = 'audio_transcription' AND payload->>'blobId' = $3 AND transcription_attempt_id = $5 AND state = 'running'")
      .bind(job_id).bind(workspace_id).bind(blob_id).bind(error).bind(attempt_id).bind(i64::from(max_attempts)).execute(&self.pool).await.map_err(db_error)?;
    Ok(update.rows_affected() == 1)
  }

  #[instrument(skip_all)]
  async fn delete_result(&self, job_id: Uuid, workspace_id: Uuid) -> RepoResult<()> {
    let mut transaction = self.pool.begin().await.map_err(db_error)?;
    let row = sqlx::query("SELECT transcription_result_id, payload->>'blobId' AS blob_id FROM copilot_jobs WHERE id = $1 AND workspace_id = $2 AND job_type = 'audio_transcription' FOR UPDATE")
      .bind(job_id).bind(workspace_id).fetch_optional(&mut *transaction).await.map_err(db_error)?.ok_or(RepositoryError::NotFound("audio_job"))?;
    let result_id: Option<Uuid> = row.get("transcription_result_id");
    let blob_id: Option<String> = row.get("blob_id");
    if let Some(id) = result_id {
      // Serialize deletion of shared historical rows before checking references.
      sqlx::query("SELECT id FROM copilot_transcripts WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(db_error)?;
    }
    sqlx::query("UPDATE copilot_jobs SET transcription_result_id = NULL, payload = payload - 'transcription', transcription_attempt_id = gen_random_uuid(), transcription_lease_until = NULL, transcription_cleanup_after = now(), state = CASE WHEN state IN ('pending', 'running', 'claimed') THEN 'failed' ELSE state END, error_message = CASE WHEN state IN ('pending', 'running', 'claimed') THEN 'transcript deleted' ELSE error_message END, updated_at = now() WHERE id = $1")
      .bind(job_id).execute(&mut *transaction).await.map_err(db_error)?;
    if let Some(id) = result_id {
      // Historical blob-scoped results may be shared by several migrated jobs.
      sqlx::query("DELETE FROM copilot_transcripts t WHERE t.id = $1 AND t.workspace_id = $2 AND t.source_type = 'audio' AND (t.source_id = $3 OR t.source_id = $4) AND NOT EXISTS (SELECT 1 FROM copilot_jobs j WHERE j.transcription_result_id = t.id)")
        .bind(id).bind(workspace_id).bind(job_id.to_string()).bind(blob_id).execute(&mut *transaction).await.map_err(db_error)?;
    }
    transaction.commit().await.map_err(db_error)
  }
}
