// SPDX-License-Identifier: AGPL-3.0-or-later
//! Telemetry worker — flush / rollup / retention job processor.
//!
//! Runs on the BullMQ-compatible `telemetry-flush` queue (own name so it
//! cannot starve the notification/doc/copilot queues).  Three job kinds:
//!
//! * `telemetry.flush` — `flush_interval_seconds` cron. Drains the hot
//!   buffer into `telemetry_events` via bulk-insert.  Idempotent (dedupe +
//!   ON CONFLICT).
//! * `telemetry.rollup` — daily at 00:05 UTC. Aggregates the previous day's
//!   `telemetry_events` into `telemetry_daily`, guarded by a Postgres
//!   advisory lock so a re-run on a restarted worker is a no-op.
//! * `telemetry.retention` — daily at 00:15 UTC.  Prunes raw events older
//!   than `retention_raw_days` and daily rollups older than
//!   `retention_daily_days`. INV-TEL-08 forbids pruning inside the retention
//!   window.  Also advisory-locked.
//!
//! Graceful shutdown: `flush_on_shutdown` is invoked from the main binary's
//! shutdown handler so events in the hot buffer are not lost when the
//! process exits before the next cron tick (INV-TEL-06).

use std::sync::Arc;

use async_trait::async_trait;
use myoxus_application::telemetry::TelemetryService;
use myoxus_domain::scheduling::registered::{RegisteredJob, RegisteredWorker};
use myoxus_worker::{Job, JobError, JobHandler};
use tracing::{info, instrument, warn};

/// Dedicated BullMQ queue name for telemetry jobs.
pub const TELEMETRY_QUEUE: &str = "telemetry-flush";

/// JobHandler for the telemetry queue.
pub struct TelemetryQueueHandler {
  pub service: Arc<TelemetryService>,
  /// Maximum number of events to drain per flush.
  pub flush_batch_max: u32,
  /// Raw-event retention in days. Entries older than this are deleted by
  /// `telemetry.retention`.
  pub retention_raw_days: u32,
  /// Daily-rollup retention in days.
  pub retention_daily_days: u32,
}

#[async_trait]
impl JobHandler for TelemetryQueueHandler {
  fn queue_name(&self) -> &str {
    TELEMETRY_QUEUE
  }

  #[instrument(skip(self, job), fields(job_id = %job.id, job_name = %job.name))]
  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    match job.name.as_str() {
      "telemetry.flush" => self.flush().await,
      "telemetry.rollup" => self.rollup().await,
      "telemetry.retention" => self.retention().await,
      other => Err(JobError::Permanent(format!("unknown telemetry job name '{other}'"))),
    }
  }
}

impl TelemetryQueueHandler {
  async fn flush(&self) -> Result<Option<serde_json::Value>, JobError> {
    let stats = self
      .service
      .flush_batch(self.flush_batch_max)
      .await
      .map_err(|e| JobError::Retryable(format!("flush_batch: {e}")))?;
    info!(
      buffered = stats.buffered,
      inserted = stats.inserted,
      "telemetry flush complete"
    );
    Ok(Some(serde_json::json!({
      "buffered": stats.buffered,
      "inserted": stats.inserted
    })))
  }

  async fn rollup(&self) -> Result<Option<serde_json::Value>, JobError> {
    let Some(rows) = self
      .service
      .rollup_previous_day()
      .await
      .map_err(|e| JobError::Retryable(format!("rollup: {e}")))?
    else {
      info!("telemetry rollup already in progress (advisory lock held) — skipping");
      return Ok(Some(serde_json::json!({ "skipped": "lock_busy" })));
    };
    info!(rows, "telemetry rollup complete");
    Ok(Some(serde_json::json!({ "rows_upserted": rows })))
  }

  async fn retention(&self) -> Result<Option<serde_json::Value>, JobError> {
    let raw_days = self.retention_raw_days.max(1);
    let daily_days = self.retention_daily_days.max(1);
    let Some((raw_deleted, daily_deleted)) = self
      .service
      .apply_retention(raw_days, daily_days)
      .await
      .map_err(|e| JobError::Retryable(format!("retention: {e}")))?
    else {
      info!("telemetry retention already in progress — skipping");
      return Ok(Some(serde_json::json!({ "skipped": "lock_busy" })));
    };

    info!(raw_deleted, daily_deleted, "telemetry retention complete");
    Ok(Some(serde_json::json!({
      "raw_deleted": raw_deleted,
      "daily_deleted": daily_deleted,
      "retentionRawDays": raw_days,
      "retentionDailyDays": daily_days
    })))
  }
}

/// Produce the three startup-owned shared worker schedules.
pub fn telemetry_schedules(flush_interval_seconds: u64) -> Vec<RegisteredWorker> {
  let every_ms = flush_interval_seconds.max(1).saturating_mul(1_000);
  vec![
    RegisteredWorker::interval(RegisteredJob::TelemetryFlush, every_ms, serde_json::json!({})),
    RegisteredWorker::cron(RegisteredJob::TelemetryRollup, "0 5 0 * * *", serde_json::json!({})),
    RegisteredWorker::cron(RegisteredJob::TelemetryRetention, "0 15 0 * * *", serde_json::json!({})),
  ]
}

/// Call on graceful shutdown (SIGTERM handler) to drain the hot buffer into
/// Postgres before the process exits.  Failures are logged but do not abort
/// shutdown — the dedupe guarantees a restart-time retry is safe.
pub async fn flush_on_shutdown(service: &TelemetryService, batch_max: u32) {
  match service.flush_batch(batch_max).await {
    Ok(stats) if stats.buffered > 0 => {
      info!(
        buffered = stats.buffered,
        inserted = stats.inserted,
        "telemetry final-flush complete"
      );
    }
    Ok(_) => {}
    Err(err) => {
      warn!(error = %err, "telemetry final-flush failed — hot buffer discarded");
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cron_jobs_carries_every_ms_for_flush() {
    let jobs = telemetry_schedules(60);
    assert_eq!(jobs.len(), 3);
    assert_eq!(jobs[0].job, RegisteredJob::TelemetryFlush);
    assert_eq!(
      jobs[0].schedule.timing,
      myoxus_domain::scheduling::registered::WorkerTiming::Interval { every_ms: 60_000 }
    );
    assert_eq!(jobs[1].job, RegisteredJob::TelemetryRollup);
    assert!(
      matches!(&jobs[1].schedule.timing,myoxus_domain::scheduling::registered::WorkerTiming::UtcCron{expression}if expression.starts_with("0 5"))
    );
    assert_eq!(jobs[2].job, RegisteredJob::TelemetryRetention);
  }

  #[test]
  fn zero_flush_interval_does_not_panic() {
    let jobs = telemetry_schedules(0);
    assert_eq!(
      jobs[0].schedule.timing,
      myoxus_domain::scheduling::registered::WorkerTiming::Interval { every_ms: 1_000 }
    );
  }
}
