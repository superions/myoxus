//! Worker queue port abstraction.
//!
//! [`WorkQueuePort`] is the application-level port for enqueueing background
//! jobs.  The production implementation delegates to the Redis-based BullMQ
//! queue in `crates/worker`.
//!
//! [`WorkerQueuePolicy`] carries per-queue concurrency and lease settings used
//! by the legacy PG worker runtime (kept for config compatibility until the
//! config schema is cleaned up separately).

use async_trait::async_trait;

use crate::auth::AuthResult;

/// Per-queue execution policy controlling concurrency and backpressure.
///
/// Still referenced by `WorkerRuntimePlan` in the API crate for config
/// parsing; kept here until config cleanup is done.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkerQueuePolicy {
  /// Maximum number of simultaneously leased jobs in this queue.
  pub max_concurrency: i64,
  /// How long (seconds) a lease is valid before it lapses.
  pub lease_seconds: i64,
  /// Number of pending jobs above which the queue is considered to be under
  /// backpressure (producers may be rate-limited).
  pub backpressure_pending_threshold: i64,
}

impl Default for WorkerQueuePolicy {
  fn default() -> Self {
    Self {
      max_concurrency: 32,
      lease_seconds: 30,
      backpressure_pending_threshold: 1_000,
    }
  }
}

/// Abstraction over job enqueueing for Redis-based queues.
#[async_trait]
pub trait WorkQueuePort: Send + Sync {
  /// Enqueue a job to the given queue with the given name and data.
  /// Returns the job ID string.
  async fn add_job(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    max_attempts: Option<u32>,
    delay_ms: Option<i64>,
  ) -> AuthResult<String>;
}
