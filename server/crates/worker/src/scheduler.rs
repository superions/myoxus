// SPDX-License-Identifier: AGPL-3.0-or-later
//! Delayed-job scheduler, stall detection sweep, and cron job scheduler.
//!
//! [`run_delayed_promotion`] is a background task that runs every
//! `check_interval` to:
//! 1. Promote delayed jobs (from the `delayed` sorted set) whose run-at
//!    timestamp ≤ now into the `wait` list.
//! 2. Detect stalled jobs in the `active` list that haven't sent a heartbeat
//!    within the stall threshold, and re-queue or fail them.
//!
//! [`run_cron_scheduler`] seeds and maintains BullMQ-compatible cron/repeat
//! jobs in the delayed set, checking every 30 seconds.

use std::str::FromStr;
use std::time::Duration;

use cron::Schedule;
use tokio::sync::watch;
use tracing::{debug, info, warn};
use uuid::Uuid;

use redis::AsyncCommands;

use crate::JobConfigSnapshot;
use crate::job::{JobOptions, JobRepeatOpts};
use crate::queue::RedisQueue;

/// Background task that promotes delayed jobs and checks for stalled jobs.
///
/// Runs on `check_interval`, iterates over all `queues`, and:
/// - Calls [`RedisQueue::promote_delayed`] to move due delayed jobs to `wait`.
/// - Calls [`RedisQueue::check_stalled`] and [`RedisQueue::recover_stalled_job`]
///   to re-queue or fail stalled jobs.
pub async fn run_delayed_promotion(
  queue: RedisQueue,
  queues: Vec<String>,
  check_interval: Duration,
  mut shutdown: watch::Receiver<bool>,
  config_watch: Option<watch::Receiver<JobConfigSnapshot>>,
) {
  info!(
    queue_count = queues.len(),
    check_interval_ms = check_interval.as_millis(),
    "delayed-job scheduler started"
  );

  // Stall check interval: 30 seconds (independent of check_interval for
  // delayed promotion, which may be shorter).
  let stall_interval_ms: i64 = 30_000;

  let mut ticker = tokio::time::interval(check_interval);
  ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

  loop {
    tokio::select! {
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() { break; }
      }
      _ = ticker.tick() => {
        for q in &queues {
          // Promote delayed → wait.
          match queue.promote_delayed(q).await {
            Ok(n) if n > 0 => {
              debug!(queue = %q, promoted = n, "promoted delayed jobs");
            }
            Ok(_) => {}
            Err(err) => {
              warn!(queue = %q, error = %err, "delayed promotion failed");
            }
          }

          // Stall detection: find stalled jobs and recover them.
          match queue.check_stalled(q, stall_interval_ms).await {
            Ok(stalled) => {
              for job_id in stalled {
                let retention = config_watch
                  .as_ref()
                  .map(|rx| rx.borrow().terminal_retention_policy())
                  .unwrap_or_default();
                if let Err(err) = queue.recover_stalled_job(q, &job_id, retention).await {
                  warn!(queue = %q, job_id = %job_id, error = %err, "stall recovery failed");
                }
              }
            }
            Err(err) => {
              warn!(queue = %q, error = %err, "stall check failed");
            }
          }
        }
      }
    }
  }

  info!("delayed-job scheduler stopped");
}

/// A recurring job to be scheduled via BullMQ-compatible delayed set.
pub struct CronJob {
  /// Queue name to enqueue into.
  pub queue: String,
  /// BullMQ job name (e.g. `"nightly.cleanExpiredUserSessions"`).
  pub job_name: String,
  /// Job payload data.
  pub data: serde_json::Value,
  /// Cron expression (e.g. `"0 0 * * *"`). Mutually exclusive with `every_ms`.
  pub cron_expr: Option<String>,
  /// Fixed interval in milliseconds. Mutually exclusive with `cron_expr`.
  pub every_ms: Option<u64>,
}

/// Seeds and maintains BullMQ-compatible cron/repeat jobs in the delayed set.
///
/// On startup and every `tick_interval_seconds` seconds thereafter, checks each
/// registered cron job. If no pending delayed job exists for it (or the scheduled
/// time is in the past), schedules the next occurrence.
///
/// Uses `bull:{prefix}:cron:{queue}:{job_name}` as a Redis string key to track
/// the next scheduled run timestamp.
pub async fn run_cron_scheduler(
  queue: RedisQueue,
  cron_jobs: Vec<CronJob>,
  tick_interval_seconds: u64,
  process_id: Uuid,
  mut shutdown: watch::Receiver<bool>,
) {
  let leader_ttl_seconds = tick_interval_seconds.saturating_mul(3).max(90);
  info!(
    job_count = cron_jobs.len(),
    tick_interval_seconds,
    leader_ttl_seconds,
    %process_id,
    "cron scheduler started"
  );

  let mut ticker = tokio::time::interval(Duration::from_secs(tick_interval_seconds));
  ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

  loop {
    tokio::select! {
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() { break; }
      }
      _ = ticker.tick() => {
        match queue.claim_cron_scheduler_leader(process_id, leader_ttl_seconds).await {
          Ok(true) => {}
          Ok(false) => {
            debug!(%process_id, "cron scheduler tick skipped because another process owns the queue lease");
            continue;
          }
          Err(error) => {
            warn!(%process_id, %error, "cron scheduler tick skipped because the queue lease is unavailable");
            continue;
          }
        }

        let now_ms = chrono::Utc::now().timestamp_millis() as u64;

        for job in &cron_jobs {
          if let Err(e) = schedule_cron_job_if_needed(&queue, job, now_ms).await {
            warn!(
              queue = %job.queue,
              job_name = %job.job_name,
              error = %e,
              "cron scheduler: failed to schedule job"
            );
          }
        }
      }
    }
  }

  info!(%process_id, "cron scheduler stopped");
}

/// Check whether the given cron job needs to be scheduled, and enqueue it if so.
async fn schedule_cron_job_if_needed(
  queue: &RedisQueue,
  job: &CronJob,
  now_ms: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  // Use a simple Redis string key to track the next scheduled run time.
  // Key format: bull:{prefix}:cron:{queue}:{job_name}
  // (We abuse the queue's internal connection for this.)
  let mut conn = queue.connection_for_cron().await?;
  let track_key = format!("cron:{}:{}", job.queue, job.job_name);

  // Read the currently scheduled timestamp (if any).
  let scheduled_at: Option<u64> = conn
    .get::<_, Option<String>>(&track_key)
    .await
    .ok()
    .flatten()
    .and_then(|s| s.parse::<u64>().ok());

  // If there's a scheduled time in the future, nothing to do.
  if let Some(ts) = scheduled_at
    && ts > now_ms
  {
    debug!(
      queue = %job.queue,
      job_name = %job.job_name,
      scheduled_at = ts,
      now_ms,
      "cron job already scheduled, skipping"
    );
    return Ok(());
  }

  // Compute next run time.
  let next_run_ms: u64 = if let Some(cron_expr) = &job.cron_expr {
    let schedule =
      Schedule::from_str(cron_expr).map_err(|e| format!("invalid cron expression '{}': {}", cron_expr, e))?;
    let next = schedule
      .upcoming(chrono::Utc)
      .next()
      .ok_or_else(|| format!("cron expression '{}' has no future occurrences", cron_expr))?;
    next.timestamp_millis() as u64
  } else if let Some(every_ms) = job.every_ms {
    now_ms + every_ms
  } else {
    warn!(job_name = %job.job_name, "cron job has neither cron_expr nor every_ms, skipping");
    return Ok(());
  };

  let delay_ms = next_run_ms.saturating_sub(now_ms) as i64;
  let repeat_key = format!("repeat:{}:{}", job.job_name, next_run_ms);

  let opts = JobOptions {
    delay_ms: Some(delay_ms),
    max_attempts: 3,
    repeat: Some(JobRepeatOpts {
      cron: job.cron_expr.clone(),
      every_ms: job.every_ms,
      job_id: Some(repeat_key),
    }),
    ..Default::default()
  };

  queue
    .enqueue(&job.queue, &job.job_name, job.data.clone(), opts)
    .await
    .map_err(|e| format!("failed to enqueue cron job '{}': {}", job.job_name, e))?;

  // Record the scheduled timestamp in Redis (expire in 2x the interval to auto-clean).
  let ttl_seconds: u64 = if let Some(every_ms) = job.every_ms {
    (every_ms / 1000).max(60) * 2
  } else {
    86_400 * 2 // 2 days for cron-based jobs
  };
  conn
    .set_ex::<_, _, ()>(&track_key, next_run_ms.to_string(), ttl_seconds)
    .await
    .map_err(|e| format!("failed to set cron track key: {e}"))?;

  info!(
    queue = %job.queue,
    job_name = %job.job_name,
    delay_ms,
    next_run_ms,
    "cron job scheduled"
  );

  Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use crate::queue::RedisQueue;
  use uuid::Uuid;

  fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
  }

  fn make_queue(extra: &str) -> RedisQueue {
    let prefix = format!("sched-test-{}-{}", extra, Uuid::new_v4().as_simple());
    RedisQueue::new(&redis_url(), prefix).expect("RedisQueue::new")
  }

  fn queue_prefix(queue: &RedisQueue) -> String {
    let debug = format!("{queue:?}");
    debug
      .split("prefix: \"")
      .nth(1)
      .and_then(|value| value.split('"').next())
      .expect("RedisQueue Debug must expose its non-secret prefix")
      .to_string()
  }

  async fn cleanup(queue: &RedisQueue, queue_name: &str) {
    let prefix = queue_prefix(queue);
    let pattern = format!("{prefix}:*");
    let mut conn = queue.connection_for_cron().await.expect("conn");
    let keys: Vec<String> = redis::cmd("KEYS")
      .arg(&pattern)
      .query_async(&mut conn)
      .await
      .unwrap_or_default();
    let cron_pattern = format!("cron:{}:*", queue_name);
    let cron_keys: Vec<String> = redis::cmd("KEYS")
      .arg(&cron_pattern)
      .query_async(&mut conn)
      .await
      .unwrap_or_default();
    let all: Vec<String> = keys.into_iter().chain(cron_keys).collect();
    if !all.is_empty() {
      let _: () = redis::cmd("DEL").arg(all).query_async(&mut conn).await.unwrap_or(());
    }
  }

  async fn wait_for_key(queue: &RedisQueue, key: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
      loop {
        let mut conn = queue.connection_for_cron().await.expect("conn");
        if conn.exists::<_, bool>(key).await.expect("EXISTS") {
          return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
      }
    })
    .await
    .expect("scheduler key must appear before timeout");
  }

  // -----------------------------------------------------------------------
  // schedule_cron_job_if_needed helper used directly
  // -----------------------------------------------------------------------

  /// Calling `schedule_cron_job_if_needed` with `every_ms = 60_000` must
  /// enqueue exactly one delayed job.
  #[tokio::test]
  async fn cron_scheduler_enqueues_job_with_every_ms() {
    let queue = make_queue("every");
    let qn = "cron-q";

    let job = CronJob {
      queue: qn.to_string(),
      job_name: "test.cronJob".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(60_000), // 60-second interval
    };

    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    schedule_cron_job_if_needed(&queue, &job, now_ms)
      .await
      .expect("schedule_cron_job_if_needed");

    // Job must appear in the delayed sorted set (not wait — it's in the
    // future by 60 seconds).
    let stats = queue.queue_stats(qn).await.expect("queue_stats");
    assert_eq!(stats.delayed, 1, "one delayed job should have been scheduled");
    cleanup(&queue, qn).await;
  }

  /// Calling `schedule_cron_job_if_needed` twice in a row for the same job
  /// must only enqueue ONE job (the second call sees the tracking key and
  /// skips).
  #[tokio::test]
  async fn cron_scheduler_does_not_duplicate_jobs_within_window() {
    let queue = make_queue("dedup");
    let qn = "dedup-q";

    let job = CronJob {
      queue: qn.to_string(),
      job_name: "test.dedupJob".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(120_000),
    };

    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    schedule_cron_job_if_needed(&queue, &job, now_ms)
      .await
      .expect("first schedule");
    schedule_cron_job_if_needed(&queue, &job, now_ms)
      .await
      .expect("second schedule (dedup)");

    let stats = queue.queue_stats(qn).await.expect("queue_stats");
    assert_eq!(
      stats.delayed, 1,
      "duplicate cron calls must produce only one scheduled job"
    );

    cleanup(&queue, qn).await;
  }

  /// A cron job with a past tracking key must be rescheduled on the next call.
  #[tokio::test]
  async fn cron_scheduler_reschedules_when_tracking_key_is_expired() {
    let queue = make_queue("reschedule");
    let qn = "resched-q";

    let job = CronJob {
      queue: qn.to_string(),
      job_name: "test.reschedJob".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(60_000),
    };

    // Simulate a past tracking key by writing one in the past (1 ms ago).
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let past_ts = now_ms - 1;
    let track_key = format!("cron:{}:{}", job.queue, job.job_name);
    let mut conn = queue.connection_for_cron().await.expect("conn");
    let _: () = redis::cmd("SET")
      .arg(&track_key)
      .arg(past_ts.to_string())
      .query_async(&mut conn)
      .await
      .expect("set past tracking key");

    // With a past tracking key the scheduler should schedule a new job.
    schedule_cron_job_if_needed(&queue, &job, now_ms)
      .await
      .expect("reschedule");

    let stats = queue.queue_stats(qn).await.expect("queue_stats");
    assert_eq!(stats.delayed, 1, "expired cron key must trigger rescheduling");

    cleanup(&queue, qn).await;
    // Clean up the cron tracking key too.
    let _: () = redis::cmd("DEL")
      .arg(&track_key)
      .query_async(&mut conn)
      .await
      .unwrap_or(());
  }

  #[tokio::test]
  async fn cron_scheduler_elects_one_process_and_allows_takeover_after_expiry() {
    let queue = make_queue("leader");
    let queue_name = "leader-q";
    let process_a = Uuid::new_v4();
    let process_b = Uuid::new_v4();
    let job_a = CronJob {
      queue: queue_name.to_string(),
      job_name: "test.leaderA".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(60_000),
    };
    let job_b = CronJob {
      queue: queue_name.to_string(),
      job_name: "test.leaderB".to_string(),
      data: serde_json::json!({}),
      cron_expr: None,
      every_ms: Some(60_000),
    };
    let track_a = format!("cron:{queue_name}:{}", job_a.job_name);
    let track_b = format!("cron:{queue_name}:{}", job_b.job_name);
    let leader_key = format!("{}:cron:scheduler:leader", queue_prefix(&queue));

    let (shutdown_a_tx, shutdown_a_rx) = watch::channel(false);
    let handle_a = tokio::spawn(run_cron_scheduler(
      queue.clone(),
      vec![job_a],
      1,
      process_a,
      shutdown_a_rx,
    ));
    wait_for_key(&queue, &track_a).await;

    let (shutdown_b_tx, shutdown_b_rx) = watch::channel(false);
    let handle_b = tokio::spawn(run_cron_scheduler(
      queue.clone(),
      vec![job_b],
      1,
      process_b,
      shutdown_b_rx,
    ));
    tokio::time::sleep(Duration::from_millis(1_200)).await;

    let mut conn = queue.connection_for_cron().await.expect("conn");
    assert!(
      !conn.exists::<_, bool>(&track_b).await.expect("EXISTS"),
      "a foreign scheduler must not enter the planning loop"
    );
    assert_eq!(
      conn.get::<_, String>(&leader_key).await.expect("leader owner"),
      process_a.to_string()
    );

    shutdown_a_tx.send(true).expect("stop first scheduler");
    handle_a.await.expect("first scheduler joins");
    assert!(
      conn
        .expire::<_, bool>(&leader_key, 1)
        .await
        .expect("shorten leader TTL"),
      "the owner lease must exist before takeover"
    );

    wait_for_key(&queue, &track_b).await;
    assert_eq!(
      conn.get::<_, String>(&leader_key).await.expect("new leader owner"),
      process_b.to_string()
    );

    shutdown_b_tx.send(true).expect("stop second scheduler");
    handle_b.await.expect("second scheduler joins");
    cleanup(&queue, queue_name).await;
  }
}
