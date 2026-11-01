// SPDX-License-Identifier: AGPL-3.0-or-later
//! Metrics worker — flush / rollup / retention jobs for the business-metrics
//! pipeline.  Structural twin of [`crate::telemetry_worker`], but operates on
//! aggregate counters instead of per-event rows:
//!
//! * `metrics.flush` — every `flush_interval_seconds`.  Calls
//!   `MetricsService::flush_now` which snapshots the recorder, UPSERTs into
//!   `metrics_raw` (INV-MET-03), and resets the hot map.
//! * `metrics.rollup` — daily at 00:10 UTC.  Aggregates yesterday's
//!   `metrics_raw` rows into `metrics_daily`, guarded by a Postgres advisory
//!   lock so repeated runs are idempotent (INV-MET-04).
//! * `metrics.retention` — daily at 00:20 UTC.  Prunes `metrics_raw` older
//!   than `retention_raw_days` and `metrics_daily` older than
//!   `retention_daily_days` (INV-MET-05).
//!
//! The server registers these jobs and performs the graceful-shutdown flush
//! only when the restart-bound `metrics.persistence_enabled` setting is true.
//! A stale queued job also checks the same startup policy before touching the
//! database.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use myoxus_application::metrics::MetricsService;
use myoxus_infrastructure::metrics::{prune_with_advisory_lock, rollup_day_with_advisory_lock};
use myoxus_worker::{CronJob, Job, JobError, JobHandler};
use sqlx::PgPool;
use tracing::{info, instrument, warn};

/// Dedicated BullMQ queue name for metrics jobs.  Separate queue so a slow
/// rollup cannot starve telemetry or business queues.
pub const METRICS_QUEUE: &str = "metrics-flush";

/// Advisory-lock IDs.  Distinct from the telemetry range.
const LOCK_ID_ROLLUP: i64 = 0x7E1E_717E_0001_0001u64 as i64;
const LOCK_ID_RETENTION: i64 = 0x7E1E_717E_0001_0002u64 as i64;

/// Executes startup-authorized metrics persistence jobs.
///
/// The handler rechecks `persistence_enabled` for every delivery because Redis
/// may still contain jobs enqueued by an earlier process configuration.
pub struct MetricsQueueHandler {
  /// In-memory recorder and persistence service.
  pub service: Arc<MetricsService>,
  /// PostgreSQL pool used for advisory locks and persisted aggregates.
  pub pool: PgPool,
  /// Startup-bound persistence switch shared by flush, rollup and retention.
  pub persistence_enabled: bool,
  /// Startup-bound raw-sample retention window in days.
  pub retention_raw_days: u32,
  /// Startup-bound daily-rollup retention window in days.
  pub retention_daily_days: u32,
}

#[async_trait]
impl JobHandler for MetricsQueueHandler {
  fn queue_name(&self) -> &str {
    METRICS_QUEUE
  }

  #[instrument(skip(self, job), fields(job_id = %job.id, job_name = %job.name))]
  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
    match job.name.as_str() {
      "metrics.flush" => self.flush().await,
      "metrics.rollup" => self.rollup().await,
      "metrics.retention" => self.retention().await,
      other => Err(JobError::Permanent(format!("unknown metrics job name '{other}'"))),
    }
  }
}

impl MetricsQueueHandler {
  async fn flush(&self) -> Result<Option<serde_json::Value>, JobError> {
    if !self.persistence_enabled {
      return Ok(Some(serde_json::json!({ "skipped": "persistence_disabled" })));
    }
    let stats = self
      .service
      .flush_now()
      .await
      .map_err(|e| JobError::Retryable(format!("flush_now: {e}")))?;
    info!(
      buffered = stats.buffered,
      inserted = stats.inserted,
      "metrics flush complete"
    );
    Ok(Some(serde_json::json!({
      "buffered": stats.buffered,
      "inserted": stats.inserted
    })))
  }

  async fn rollup(&self) -> Result<Option<serde_json::Value>, JobError> {
    if !self.persistence_enabled {
      return Ok(Some(serde_json::json!({ "skipped": "persistence_disabled" })));
    }
    let day = (Utc::now() - Duration::days(1)).date_naive();
    let Some(rows) = rollup_day_with_advisory_lock(&self.pool, LOCK_ID_ROLLUP, day)
      .await
      .map_err(|e| JobError::Retryable(format!("rollup: {e}")))?
    else {
      info!("metrics rollup already in progress (advisory lock held) — skipping");
      return Ok(Some(serde_json::json!({ "skipped": "lock_busy" })));
    };
    info!(%day, rows, "metrics rollup complete");
    Ok(Some(
      serde_json::json!({ "day": day.to_string(), "rows_upserted": rows }),
    ))
  }

  async fn retention(&self) -> Result<Option<serde_json::Value>, JobError> {
    if !self.persistence_enabled {
      return Ok(Some(serde_json::json!({ "skipped": "persistence_disabled" })));
    }
    // INV-MET-05: clamp to >= 1 day so a misconfigured `retention_raw_days=0`
    // cannot prune the current window.
    let raw_days = self.retention_raw_days.max(1);
    let daily_days = self.retention_daily_days.max(1);
    let raw_cutoff = Utc::now() - Duration::days(raw_days as i64);
    let daily_cutoff = (Utc::now() - Duration::days(daily_days as i64)).date_naive();

    let Some((raw_deleted, daily_deleted)) =
      prune_with_advisory_lock(&self.pool, LOCK_ID_RETENTION, raw_cutoff, daily_cutoff)
        .await
        .map_err(|e| JobError::Retryable(format!("retention: {e}")))?
    else {
      info!("metrics retention already in progress — skipping");
      return Ok(Some(serde_json::json!({ "skipped": "lock_busy" })));
    };

    info!(
      raw_deleted,
      daily_deleted,
      retention_raw_days = raw_days,
      retention_daily_days = daily_days,
      "metrics retention complete"
    );
    Ok(Some(serde_json::json!({
      "raw_deleted": raw_deleted,
      "daily_deleted": daily_deleted,
      "retentionRawDays": raw_days,
      "retentionDailyDays": daily_days
    })))
  }
}

/// Produces the persistence schedules for the metrics pipeline.
///
/// Callers must invoke this only when persistence is enabled. The handler
/// repeats that check so a stale Redis job cannot write after a restart with
/// persistence disabled.
pub fn metrics_cron_jobs(flush_interval_seconds: u64) -> Vec<CronJob> {
  let every_ms = flush_interval_seconds.max(1).saturating_mul(1_000);
  vec![
    CronJob {
      queue: METRICS_QUEUE.to_string(),
      job_name: "metrics.flush".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(every_ms),
    },
    CronJob {
      queue: METRICS_QUEUE.to_string(),
      job_name: "metrics.rollup".to_string(),
      data: serde_json::json!({}),
      // 6-field cron: sec min hour dom mon dow — 00:10 UTC daily.
      cron_expr: Some("0 10 0 * * *".to_string()),
      every_ms: None,
    },
    CronJob {
      queue: METRICS_QUEUE.to_string(),
      job_name: "metrics.retention".to_string(),
      data: serde_json::json!({}),
      // 00:20 UTC daily (spaced 10 min after rollup).
      cron_expr: Some("0 20 0 * * *".to_string()),
      every_ms: None,
    },
  ]
}

/// Flushes in-memory counters during graceful shutdown when persistence is enabled.
///
/// Failures are logged but do not abort shutdown. With persistence disabled,
/// the function deliberately leaves the in-memory Prometheus state untouched
/// and performs no database call.
pub async fn flush_on_shutdown(service: &MetricsService, persistence_enabled: bool) {
  if !persistence_enabled {
    return;
  }
  match service.flush_now().await {
    Ok(stats) if stats.buffered > 0 => {
      info!(
        buffered = stats.buffered,
        inserted = stats.inserted,
        "metrics final-flush complete"
      );
    }
    Ok(_) => {}
    Err(err) => {
      warn!(error = %err, "metrics final-flush failed — hot buffer discarded");
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cron_jobs_have_flush_rollup_retention() {
    let jobs = metrics_cron_jobs(60);
    assert_eq!(jobs.len(), 3);
    assert_eq!(jobs[0].job_name, "metrics.flush");
    assert_eq!(jobs[0].every_ms, Some(60_000));
    assert_eq!(jobs[1].job_name, "metrics.rollup");
    assert!(jobs[1].cron_expr.as_deref().unwrap_or("").starts_with("0 10"));
    assert_eq!(jobs[2].job_name, "metrics.retention");
    assert!(jobs[2].cron_expr.as_deref().unwrap_or("").starts_with("0 20"));
  }

  #[test]
  fn zero_flush_interval_clamps_to_one_second() {
    let jobs = metrics_cron_jobs(0);
    assert_eq!(jobs[0].every_ms, Some(1_000));
  }
}
