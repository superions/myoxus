//! Worker configuration types.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::job::BackoffStrategy;

/// Per-queue configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueConfig {
  /// Maximum number of concurrent jobs processed for this queue.
  #[serde(default = "default_concurrency")]
  pub concurrency: usize,
  /// Maximum number of processing attempts before the job is failed.
  #[serde(default = "default_max_attempts")]
  pub max_attempts: i32,
  /// Backoff strategy between retries.
  #[serde(default)]
  pub backoff: BackoffStrategy,
  /// Stall detection interval in milliseconds.
  #[serde(default = "default_stall_interval_ms")]
  pub stall_interval_ms: u64,
  /// Optional cron expression for recurring jobs (e.g. `"0 0 * * *"` for daily).
  pub cron: Option<String>,
}

fn default_concurrency() -> usize {
  4
}

fn default_max_attempts() -> i32 {
  3
}

fn default_stall_interval_ms() -> u64 {
  30_000
}

impl Default for QueueConfig {
  fn default() -> Self {
    Self {
      concurrency: default_concurrency(),
      max_attempts: default_max_attempts(),
      backoff: BackoffStrategy::default(),
      stall_interval_ms: default_stall_interval_ms(),
      cron: None,
    }
  }
}

/// Global runtime configuration for the worker system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
  /// Maximum duration for the bounded atomic dequeue poll in seconds.
  ///
  /// The queue uses a non-blocking Lua transaction at 100 ms intervals because
  /// Redis scripts cannot contain blocking list commands.
  #[serde(default = "default_poll_timeout_seconds")]
  pub poll_timeout_seconds: u64,
  /// Heartbeat interval in milliseconds during job processing.
  #[serde(default = "default_heartbeat_interval_ms")]
  pub heartbeat_interval_ms: u64,
  /// How often to run the stall detection sweep in milliseconds.
  #[serde(default = "default_stall_check_interval_ms")]
  pub stall_check_interval_ms: u64,
  /// Maximum time to wait for in-flight jobs during shutdown.
  #[serde(default = "default_shutdown_timeout_seconds")]
  pub shutdown_timeout_seconds: u64,
}

fn default_poll_timeout_seconds() -> u64 {
  5
}

fn default_heartbeat_interval_ms() -> u64 {
  15_000
}

fn default_stall_check_interval_ms() -> u64 {
  30_000
}

fn default_shutdown_timeout_seconds() -> u64 {
  30
}

impl Default for RuntimeConfig {
  fn default() -> Self {
    Self {
      poll_timeout_seconds: default_poll_timeout_seconds(),
      heartbeat_interval_ms: default_heartbeat_interval_ms(),
      stall_check_interval_ms: default_stall_check_interval_ms(),
      shutdown_timeout_seconds: default_shutdown_timeout_seconds(),
    }
  }
}

/// Snapshot of admin-configurable job settings, reloaded at runtime.
///
/// The worker reads this from a `tokio::sync::watch` channel on each loop
/// iteration, allowing live config changes (e.g. via the Admin UI) to take
/// effect without a server restart.
#[derive(Debug, Clone)]
pub struct JobConfigSnapshot {
  /// Per-queue concurrency overrides. Key = queue name (e.g. "copilot", "doc").
  pub queue_concurrency: HashMap<String, usize>,
  /// Global max attempts override (from `job.queue.attempts`).
  pub max_attempts: i32,
  /// Bounded atomic dequeue poll duration in seconds (from
  /// `job.worker.pollTimeoutSeconds`).
  pub poll_timeout_seconds: u64,
  /// Remove successful job records immediately (from `job.queue.removeOnComplete`).
  pub remove_on_complete: bool,
  /// Failed-job retention age in seconds (from `job.queue.removeOnFail.age`).
  pub remove_on_fail_age_seconds: u64,
  /// Maximum failed jobs retained per queue (from `job.queue.removeOnFail.count`).
  pub remove_on_fail_count: u32,
}

impl Default for JobConfigSnapshot {
  fn default() -> Self {
    Self {
      queue_concurrency: HashMap::new(),
      max_attempts: 3,
      poll_timeout_seconds: 5,
      remove_on_complete: true,
      remove_on_fail_age_seconds: 86_400,
      remove_on_fail_count: 500,
    }
  }
}

impl JobConfigSnapshot {
  pub fn terminal_retention_policy(&self) -> TerminalRetentionPolicy {
    TerminalRetentionPolicy {
      remove_on_complete: self.remove_on_complete,
      failed_age_seconds: self.remove_on_fail_age_seconds,
      failed_max_count: self.remove_on_fail_count,
    }
  }
}

/// Runtime policy for terminal Redis queue records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalRetentionPolicy {
  pub remove_on_complete: bool,
  pub failed_age_seconds: u64,
  pub failed_max_count: u32,
}

impl Default for TerminalRetentionPolicy {
  fn default() -> Self {
    JobConfigSnapshot::default().terminal_retention_policy()
  }
}
