//! Job types for the Redis-based BullMQ-compatible worker queue.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Status of a job in the BullMQ-compatible queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
  Waiting,
  Active,
  Completed,
  Failed,
  Delayed,
  Paused,
}

impl fmt::Display for JobStatus {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let s = match self {
      Self::Waiting => "waiting",
      Self::Active => "active",
      Self::Completed => "completed",
      Self::Failed => "failed",
      Self::Delayed => "delayed",
      Self::Paused => "paused",
    };
    f.write_str(s)
  }
}

impl FromStr for JobStatus {
  type Err = String;

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    match s {
      "waiting" => Ok(Self::Waiting),
      "active" => Ok(Self::Active),
      "completed" => Ok(Self::Completed),
      "failed" => Ok(Self::Failed),
      "delayed" => Ok(Self::Delayed),
      "paused" => Ok(Self::Paused),
      other => Err(format!("unknown job status: {other}")),
    }
  }
}

/// Counts of jobs in each status for a queue.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobCounts {
  pub waiting: i64,
  pub active: i64,
  pub completed: i64,
  pub failed: i64,
  pub delayed: i64,
  pub paused: i64,
}

/// A job record stored in Redis, compatible with BullMQ data layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
  /// Unique job identifier (auto-incremented within the queue).
  pub id: String,
  /// Job type name (e.g. `"sendInvitation"`, `"indexDoc"`).
  pub name: String,
  /// Arbitrary JSON payload interpreted by the handler.
  pub data: serde_json::Value,
  /// Job execution options.
  pub opts: JobOptions,
  /// Unix timestamp in milliseconds when the job was created.
  pub timestamp: i64,
  /// Number of processing attempts made so far.
  #[serde(rename = "attemptsMade")]
  pub attempts_made: i32,
  /// Unix timestamp in milliseconds when the job completed.
  #[serde(rename = "finishedOn")]
  pub finished_on: Option<i64>,
  /// Error message from the most recent failed attempt.
  #[serde(rename = "failedReason")]
  pub failed_reason: Option<String>,
  /// Unix timestamp in milliseconds of the last heartbeat.
  pub heartbeat: Option<i64>,
  /// Return value from a successfully completed job.
  #[serde(rename = "returnvalue")]
  pub return_value: Option<serde_json::Value>,
}

/// Options controlling job execution behaviour.
/// Historical queued `repeat` metadata is deliberately ignored by serde;
/// only the stopped-owner importer reads it, never native execution timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobOptions {
  /// Maximum number of attempts before the job is moved to the failed set.
  #[serde(rename = "maxAttempts", default = "default_max_attempts")]
  pub max_attempts: i32,
  /// Backoff strategy between retry attempts.
  #[serde(default)]
  pub backoff: BackoffStrategy,
  /// Optional delay in milliseconds before the job becomes available.
  #[serde(rename = "delayMs")]
  pub delay_ms: Option<i64>,
}

fn default_max_attempts() -> i32 {
  3
}

impl Default for JobOptions {
  fn default() -> Self {
    Self {
      max_attempts: default_max_attempts(),
      backoff: BackoffStrategy::default(),
      delay_ms: None,
    }
  }
}

/// Strategy for computing retry delays.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BackoffStrategy {
  /// Exponential backoff: delay * 2^(attempt - 1).
  Exponential {
    #[serde(rename = "delayMs", default = "default_backoff_delay")]
    delay_ms: i64,
  },
  /// Linear backoff: delay * attempt.
  Linear {
    #[serde(rename = "delayMs", default = "default_backoff_delay")]
    delay_ms: i64,
  },
  /// Fixed delay between every retry.
  Fixed {
    #[serde(rename = "delayMs", default = "default_backoff_delay")]
    delay_ms: i64,
  },
}

fn default_backoff_delay() -> i64 {
  1000
}

impl Default for BackoffStrategy {
  fn default() -> Self {
    Self::Exponential {
      delay_ms: default_backoff_delay(),
    }
  }
}

impl BackoffStrategy {
  /// Compute the retry delay in milliseconds for the given attempt number (1-based).
  pub fn delay_for_attempt(&self, attempt: i32) -> i64 {
    let attempt = attempt.max(1) as i64;
    match self {
      Self::Exponential { delay_ms } => delay_ms * (1i64 << (attempt - 1).min(20)),
      Self::Linear { delay_ms } => delay_ms * attempt,
      Self::Fixed { delay_ms } => *delay_ms,
    }
  }
}

/// Error returned by a job handler.
#[derive(Debug, thiserror::Error)]
pub enum JobError {
  /// A retryable error — the job will be rescheduled according to its backoff strategy.
  #[error("retryable: {0}")]
  Retryable(String),
  /// A permanent error — the job will be moved to the failed set immediately.
  #[error("permanent: {0}")]
  Permanent(String),
}
