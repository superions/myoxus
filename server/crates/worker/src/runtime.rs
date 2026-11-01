// SPDX-License-Identifier: AGPL-3.0-or-later
//! Worker runtime: one Tokio task per queue, with per-queue concurrency control.
//!
//! Each registered queue gets a [`run_queue_loop`] task that:
//! 1. Calls [`RedisQueue::dequeue`] with a configurable bounded poll duration.
//! 2. Dispatches the job to the registered [`JobHandler`].
//! 3. Spawns a heartbeat task for long-running jobs.
//! 4. Acknowledges or fails the job based on the handler result.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, instrument, warn};

use crate::config::{JobConfigSnapshot, QueueConfig, RuntimeConfig};
use crate::job::{Job, JobError};
use crate::queue::RedisQueue;

/// A queue job processor.
///
/// Implement this trait for each queue domain. The handler receives a fully
/// decoded [`Job`] and must return either a success payload or a [`JobError`].
#[async_trait]
pub trait JobHandler: Send + Sync {
  /// Name of the queue this handler processes.
  fn queue_name(&self) -> &str;

  /// Process a single job.
  ///
  /// - Return `Ok(return_value)` to acknowledge the job as completed.
  /// - Return `Err(JobError::Retryable(msg))` to reschedule according to the
  ///   queue's backoff strategy.
  /// - Return `Err(JobError::Permanent(msg))` to move the job to the failed
  ///   set immediately.
  async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError>;

  /// Reconcile domain-owned durable work through the normal queue lifecycle.
  /// The runtime bounds this callback and supplies its existing queue policy.
  async fn recover(&self, _max_attempts: u32, _dispatch_seconds: u32) -> Result<(), String> {
    Ok(())
  }

  /// Persist domain-owned terminal state before an exhausted retryable job is
  /// moved to the queue's failed set.
  async fn on_retry_exhausted(&self, _job: &Job, _message: &str) -> Result<(), String> {
    Ok(())
  }
}

/// Manages the background worker task per registered queue.
pub struct WorkerRuntime {
  queue: RedisQueue,
  handlers: Vec<(Box<dyn JobHandler>, QueueConfig)>,
  global: RuntimeConfig,
  shutdown: watch::Receiver<bool>,
  /// Optional config watch channel for runtime-reloadable settings.
  /// When `None`, the worker uses static config from registration time.
  config_watch: Option<watch::Receiver<JobConfigSnapshot>>,
}

impl WorkerRuntime {
  /// Create a new runtime. Call [`register`] to add queue handlers, then
  /// [`spawn`] to start all worker loops.
  pub fn new(queue: RedisQueue, global: RuntimeConfig, shutdown: watch::Receiver<bool>) -> Self {
    Self {
      queue,
      handlers: Vec::new(),
      global,
      shutdown,
      config_watch: None,
    }
  }

  /// Attach a config watch channel for runtime-reloadable job settings.
  ///
  /// When set, each queue loop reads the latest [`JobConfigSnapshot`] on every
  /// iteration, allowing live config changes (e.g. concurrency adjustments
  /// from the Admin UI) to take effect without a server restart.
  pub fn with_config_watch(mut self, rx: watch::Receiver<JobConfigSnapshot>) -> Self {
    self.config_watch = Some(rx);
    self
  }

  /// Register a handler for its declared queue.
  pub fn register(&mut self, handler: impl JobHandler + 'static, config: QueueConfig) {
    self.handlers.push((Box::new(handler), config));
  }

  /// Actual handler inventory used to verify operator visibility before spawn.
  pub fn queue_names(&self) -> impl Iterator<Item = &str> {
    self.handlers.iter().map(|(handler, _)| handler.queue_name())
  }

  /// Spawn a Tokio task for each registered queue. Returns the join handles.
  ///
  /// Before starting the processing loops, runs a one-time reconciliation pass
  /// (WRK-RV-02b) that cleans up any orphaned job hashes left behind by
  /// previous crashes.
  pub fn spawn(self) -> Vec<JoinHandle<()>> {
    let queue = self.queue;
    let global = self.global;
    let shutdown = self.shutdown;
    let startup_retention = self
      .config_watch
      .as_ref()
      .map(|rx| rx.borrow().terminal_retention_policy())
      .unwrap_or_default();
    let mut handles = Vec::new();

    // WRK-RV-02b: Reconcile orphaned jobs for each queue before starting workers.
    // This is a one-shot cleanup task that runs at startup.
    let queue_names: Vec<String> = self.handlers.iter().map(|(h, _)| h.queue_name().to_string()).collect();
    {
      let queue_for_reconcile = queue.clone();
      let names = queue_names.clone();
      handles.push(tokio::spawn(async move {
        for qn in &names {
          match queue_for_reconcile.prune_failed_jobs(qn, startup_retention).await {
            Ok(count) if count > 0 => {
              info!(queue = %qn, count, "bounded failed queue history at startup");
            }
            Ok(_) => {}
            Err(err) => {
              warn!(queue = %qn, error = %err, "failed to prune failed queue history at startup (non-fatal)");
            }
          }
          match queue_for_reconcile.reconcile_orphaned_jobs(qn).await {
            Ok(count) if count > 0 => {
              info!(queue = %qn, count, "WRK-RV-02b: reconciled orphaned jobs at startup");
            }
            Ok(_) => {
              debug!(queue = %qn, "WRK-RV-02b: no orphaned jobs at startup");
            }
            Err(err) => {
              warn!(queue = %qn, error = %err, "WRK-RV-02b: failed to reconcile orphaned jobs (non-fatal)");
            }
          }
        }
      }));
    }

    // Spawn the delayed-job promotion task for all queues.
    let promotion_queue_names: Vec<String> = self.handlers.iter().map(|(h, _)| h.queue_name().to_string()).collect();
    handles.push(tokio::spawn(crate::scheduler::run_delayed_promotion(
      queue.clone(),
      promotion_queue_names,
      Duration::from_millis(global.stall_check_interval_ms),
      shutdown.clone(),
      self.config_watch.clone(),
    )));

    for (handler, config) in self.handlers {
      let queue = queue.clone();
      let global = global.clone();
      let shutdown = shutdown.clone();
      let config_watch = self.config_watch.clone();
      // WRK-RV-01: Arc enables cloning the handler into spawned per-job tasks.
      let handler: Arc<dyn JobHandler> = handler.into();
      handles.push(tokio::spawn(run_queue_loop(
        handler,
        config,
        queue,
        global,
        shutdown,
        config_watch,
      )));
    }

    handles
  }
}

/// Main processing loop for a single queue.
#[instrument(skip(handler, config, queue, shutdown, config_watch), fields(queue = handler.queue_name()))]
async fn run_queue_loop(
  handler: Arc<dyn JobHandler>,
  config: QueueConfig,
  queue: RedisQueue,
  global: RuntimeConfig,
  mut shutdown: watch::Receiver<bool>,
  config_watch: Option<watch::Receiver<JobConfigSnapshot>>,
) {
  let queue_name = handler.queue_name().to_string();
  let mut current_concurrency = config.concurrency;
  let mut current_max_attempts = config.max_attempts.max(1);
  let mut current_poll_timeout = global.poll_timeout_seconds;
  let mut current_retention = config_watch
    .as_ref()
    .map(|rx| rx.borrow().terminal_retention_policy())
    .unwrap_or_default();
  let mut semaphore = Arc::new(Semaphore::new(current_concurrency));
  let recovery_interval = Duration::from_millis(global.stall_check_interval_ms.max(1));
  let mut next_recovery = tokio::time::Instant::now();

  info!(
    queue = %queue_name,
    concurrency = current_concurrency,
    max_attempts = config.max_attempts,
    poll_timeout_seconds = current_poll_timeout,
    "worker queue loop started"
  );

  loop {
    // Check shutdown before blocking.
    if *shutdown.borrow() {
      break;
    }

    // Read latest config snapshot and adjust concurrency / poll timeout if changed.
    if let Some(ref cw) = config_watch {
      let snapshot = cw.borrow().clone();
      let effective = snapshot
        .queue_concurrency
        .get(&queue_name)
        .copied()
        .unwrap_or(config.concurrency);

      if effective != current_concurrency {
        info!(
          queue = %queue_name,
          old = current_concurrency,
          new = effective,
          "runtime config: concurrency updated"
        );
        current_concurrency = effective;
        semaphore = Arc::new(Semaphore::new(current_concurrency));
      }

      if snapshot.poll_timeout_seconds != current_poll_timeout {
        info!(
          queue = %queue_name,
          old = current_poll_timeout,
          new = snapshot.poll_timeout_seconds,
          "runtime config: poll_timeout_seconds updated"
        );
        current_poll_timeout = snapshot.poll_timeout_seconds;
      }

      let effective_max_attempts = snapshot.max_attempts.max(1);
      if effective_max_attempts != current_max_attempts {
        info!(
          queue = %queue_name,
          old = current_max_attempts,
          new = effective_max_attempts,
          "runtime config: max attempts updated"
        );
        current_max_attempts = effective_max_attempts;
      }

      current_retention = snapshot.terminal_retention_policy();
    }

    if tokio::time::Instant::now() >= next_recovery {
      next_recovery = tokio::time::Instant::now() + recovery_interval;
      let dispatch_seconds = recovery_interval
        .as_millis()
        .div_ceil(1000)
        .max(1)
        .min(u128::from(u32::MAX)) as u32;
      tokio::select! {
        changed = shutdown.changed() => {
          if changed.is_err() || *shutdown.borrow() { break; }
        }
        outcome = tokio::time::timeout(recovery_interval, handler.recover(current_max_attempts as u32, dispatch_seconds)) => {
          match outcome {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(queue = %queue_name, error = %error, "durable queue recovery failed"),
            Err(_) => warn!(queue = %queue_name, "durable queue recovery deadline exceeded"),
          }
        }
      }
    }

    // Try to acquire a concurrency slot.
    let permit = match semaphore.clone().try_acquire_owned() {
      Ok(p) => p,
      Err(_) => {
        // At max concurrency — wait briefly before checking again.
        tokio::select! {
          changed = shutdown.changed() => {
            if changed.is_err() || *shutdown.borrow() { break; }
          }
          _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
        continue;
      }
    };

    // Atomic, bounded dequeue poll with a configurable overall duration.
    let job = tokio::select! {
      biased;
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() { break; }
        drop(permit);
        continue;
      }
      result = queue.dequeue(&queue_name, current_poll_timeout) => {
        match result {
          Ok(Some(job)) => job,
          Ok(None) => {
            drop(permit);
            continue; // timeout, no jobs
          }
          Err(err) => {
            warn!(queue = %queue_name, error = %err, "dequeue error");
            drop(permit);
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
          }
        }
      }
    };

    let job_id = job.id.clone();
    let queue_name_for_task = queue_name.clone();
    let queue_for_task = queue.clone();
    let heartbeat_interval = global.heartbeat_interval_ms;
    let backoff = config.backoff.clone();
    let max_attempts = current_max_attempts;
    let retention = current_retention;

    // WRK-RV-01: Spawn job processing as a separate Tokio task so the queue
    // loop can immediately dequeue the next job (true parallel concurrency).
    let handler_clone = handler.clone();
    let shutdown_clone = shutdown.clone();
    tokio::spawn(async move {
      let handler_ref: &dyn JobHandler = handler_clone.as_ref();
      let result = process_job_with_heartbeat(
        handler_ref,
        &job,
        &queue_for_task,
        &queue_name_for_task,
        heartbeat_interval,
        shutdown_clone,
      )
      .await;

      match result {
        Ok(return_value) => {
          debug!(queue = %queue_name_for_task, job_id = %job_id, "job completed");
          if let Err(err) = queue_for_task
            .ack(&queue_name_for_task, &job_id, return_value, retention)
            .await
          {
            // QUEUE-ROB-05: If ack fails, explicitly fail the job to prevent it
            // staying in active forever. The stall checker would eventually recover
            // it, but that causes a redundant re-execution.
            warn!(queue = %queue_name_for_task, job_id = %job_id, error = %err, "ack failed, marking as failed");
            let _ = queue_for_task
              .fail(
                &queue_name_for_task,
                &job_id,
                &format!("ack failed: {err}"),
                None,
                retention,
              )
              .await;
          }
        }
        Err(JobError::Retryable(msg)) => {
          let attempt = job.attempts_made + 1;
          if attempt >= max_attempts {
            error!(queue = %queue_name_for_task, job_id = %job_id, attempt, max_attempts, %msg, "job exhausted retry budget");
            if let Err(error) = handler_ref.on_retry_exhausted(&job, &msg).await {
              error!(queue = %queue_name_for_task, job_id = %job_id, %error, "failed to persist exhausted job state");
            }
            if let Err(err) = queue_for_task
              .fail(&queue_name_for_task, &job_id, &msg, None, retention)
              .await
            {
              warn!(queue = %queue_name_for_task, job_id = %job_id, error = %err, "failed to record exhausted job");
            }
          } else {
            let delay_ms = backoff.delay_for_attempt(attempt);
            let retry_at = Utc::now().timestamp_millis() + delay_ms;
            warn!(queue = %queue_name_for_task, job_id = %job_id, attempt, max_attempts, delay_ms, %msg, "job failed, will retry");
            if let Err(err) = queue_for_task
              .fail(&queue_name_for_task, &job_id, &msg, Some(retry_at), retention)
              .await
            {
              warn!(queue = %queue_name_for_task, job_id = %job_id, error = %err, "failed to record job failure");
            }
          }
        }
        Err(JobError::Permanent(msg)) => {
          error!(queue = %queue_name_for_task, job_id = %job_id, %msg, "job permanently failed");
          if let Err(err) = queue_for_task
            .fail(&queue_name_for_task, &job_id, &msg, None, retention)
            .await
          {
            warn!(queue = %queue_name_for_task, job_id = %job_id, error = %err, "failed to record permanent failure");
          }
        }
      }

      drop(permit); // Release concurrency slot after job completes
    });
  }

  info!(queue = %queue_name, "worker queue loop stopped");
}

/// Run a job handler with a concurrent heartbeat task.
async fn process_job_with_heartbeat(
  handler: &dyn JobHandler,
  job: &Job,
  queue: &RedisQueue,
  queue_name: &str,
  heartbeat_interval_ms: u64,
  mut shutdown: watch::Receiver<bool>,
) -> Result<Option<serde_json::Value>, JobError> {
  let job_id = job.id.clone();
  let queue_name = queue_name.to_string();
  let queue_for_hb = queue.clone();
  let mut hb_interval = tokio::time::interval(Duration::from_millis(heartbeat_interval_ms));
  hb_interval.tick().await; // skip immediate first tick

  // Use select! to run handler and heartbeat concurrently.
  tokio::select! {
    biased;
    changed = shutdown.changed() => {
      if changed.is_err() || *shutdown.borrow() {
        return Err(JobError::Retryable("shutdown during processing".to_string()));
      }
      handler.process(job).await
    }
    result = handler.process(job) => result,
    _ = async {
      loop {
        hb_interval.tick().await;
        if let Err(err) = queue_for_hb.heartbeat(&queue_name, &job_id).await {
          warn!(%queue_name, %job_id, error = %err, "heartbeat failed");
        }
      }
    } => unreachable!("heartbeat loop does not complete"),
  }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use crate::config::QueueConfig;
  use crate::job::{BackoffStrategy, Job, JobError, JobOptions};
  use crate::queue::RedisQueue;
  use std::sync::Arc;
  use std::sync::atomic::{AtomicI32, Ordering};
  use tokio::sync::watch;
  use uuid::Uuid;

  fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
  }

  fn make_queue() -> RedisQueue {
    let prefix = format!("rt-test-{}", Uuid::new_v4().as_simple());
    RedisQueue::new(&redis_url(), prefix).expect("RedisQueue::new")
  }

  fn fast_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
      // Very short poll timeout so dequeue doesn't block the test runner.
      poll_timeout_seconds: 1,
      heartbeat_interval_ms: 5_000,
      // Short stall_check_interval so the delayed-promotion task reacts
      // to the shutdown signal quickly (avoids 60-second hangs in tests).
      stall_check_interval_ms: 200,
      shutdown_timeout_seconds: 5,
    }
  }

  // -----------------------------------------------------------------------
  // TestHandler: records processed job names in an Arc<Mutex<Vec<String>>>
  // -----------------------------------------------------------------------

  struct CollectingHandler {
    queue: String,
    collected: Arc<std::sync::Mutex<Vec<String>>>,
  }

  #[async_trait::async_trait]
  impl JobHandler for CollectingHandler {
    fn queue_name(&self) -> &str {
      &self.queue
    }
    async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
      self
        .collected
        .lock()
        .expect("test: collected mutex poisoned")
        .push(job.name.clone());
      Ok(None)
    }
  }

  // -----------------------------------------------------------------------
  // SlowHandler: sleeps a fixed duration, counts concurrent invocations
  // -----------------------------------------------------------------------

  struct SlowHandler {
    queue: String,
    sleep_ms: u64,
    concurrent_count: Arc<AtomicI32>,
    max_concurrent_seen: Arc<AtomicI32>,
  }

  struct RetryableHandler {
    queue: String,
    attempts: Arc<AtomicI32>,
    exhausted: Arc<AtomicI32>,
  }

  #[async_trait::async_trait]
  impl JobHandler for RetryableHandler {
    fn queue_name(&self) -> &str {
      &self.queue
    }

    async fn process(&self, _job: &Job) -> Result<Option<serde_json::Value>, JobError> {
      self.attempts.fetch_add(1, Ordering::SeqCst);
      Err(JobError::Retryable("transient failure".to_string()))
    }

    async fn on_retry_exhausted(&self, _job: &Job, _message: &str) -> Result<(), String> {
      self.exhausted.fetch_add(1, Ordering::SeqCst);
      Ok(())
    }
  }

  #[async_trait::async_trait]
  impl JobHandler for SlowHandler {
    fn queue_name(&self) -> &str {
      &self.queue
    }
    async fn process(&self, _job: &Job) -> Result<Option<serde_json::Value>, JobError> {
      let cur = self.concurrent_count.fetch_add(1, Ordering::SeqCst) + 1;
      // Track peak concurrent count.
      let mut prev = self.max_concurrent_seen.load(Ordering::SeqCst);
      loop {
        if cur <= prev {
          break;
        }
        match self
          .max_concurrent_seen
          .compare_exchange(prev, cur, Ordering::SeqCst, Ordering::SeqCst)
        {
          Ok(_) => break,
          Err(actual) => prev = actual,
        }
      }
      tokio::time::sleep(std::time::Duration::from_millis(self.sleep_ms)).await;
      self.concurrent_count.fetch_sub(1, Ordering::SeqCst);
      Ok(None)
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  // Each test uses a unique queue prefix via `make_queue()`, so keys are
  // naturally isolated and won't interfere with parallel test runs.
  // Cleanup is best-effort: the test-prefix keys will expire naturally in
  // a local Redis instance, and tests use isolated prefixes so no cleanup
  // is strictly required for correctness.

  // -----------------------------------------------------------------------
  // Test: runtime dispatches all enqueued jobs
  // -----------------------------------------------------------------------

  /// The runtime must pick up and process every job that has been enqueued.
  #[tokio::test]
  async fn worker_runtime_dispatches_jobs_to_handler() {
    let queue = make_queue();
    let qn = "dispatch-test";

    // Enqueue 3 jobs.
    for i in 0..3u32 {
      queue
        .enqueue(qn, &format!("job-{i}"), serde_json::json!({}), JobOptions::default())
        .await
        .expect("enqueue");
    }

    let collected: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

    let handler = CollectingHandler {
      queue: qn.to_string(),
      collected: collected.clone(),
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime = WorkerRuntime::new(queue.clone(), fast_runtime_config(), shutdown_rx);
    runtime.register(
      handler,
      QueueConfig {
        concurrency: 3,
        ..Default::default()
      },
    );

    let handles = runtime.spawn();

    // Give the runtime time to process the 3 jobs.
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let _ = shutdown_tx.send(true);
    for h in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    }

    let names = collected.lock().expect("test: collected mutex poisoned").clone();
    assert_eq!(names.len(), 3, "runtime must process all 3 jobs, processed: {names:?}");
  }

  #[tokio::test]
  async fn worker_runtime_stops_retrying_after_configured_attempt_budget() {
    let queue = make_queue();
    let qn = "retry-budget-test";
    queue
      .enqueue(qn, "retryable", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");
    let attempts = Arc::new(AtomicI32::new(0));
    let exhausted = Arc::new(AtomicI32::new(0));
    let handler = RetryableHandler {
      queue: qn.to_string(),
      attempts: attempts.clone(),
      exhausted: exhausted.clone(),
    };
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime_config = fast_runtime_config();
    runtime_config.stall_check_interval_ms = 20;
    let mut runtime = WorkerRuntime::new(queue.clone(), runtime_config, shutdown_rx);
    runtime.register(
      handler,
      QueueConfig {
        concurrency: 1,
        max_attempts: 3,
        backoff: BackoffStrategy::Fixed { delay_ms: 10 },
        ..Default::default()
      },
    );
    let handles = runtime.spawn();

    tokio::time::timeout(std::time::Duration::from_secs(3), async {
      loop {
        // Retry-budget ownership belongs to the runtime. Promote any due
        // delivery explicitly so this invariant does not depend on the
        // independently tested scheduler ticker winning time under suite load.
        queue.promote_delayed(qn).await.expect("promote due retry delivery");
        let (_, failed) = queue.list_jobs(qn, "failed", 0, 10).await.expect("failed jobs");
        if failed == 1 {
          break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
      }
    })
    .await
    .expect("retry budget must terminate");
    assert_eq!(
      attempts.load(Ordering::SeqCst),
      3,
      "handler must execute exactly the configured number of attempts"
    );
    assert_eq!(
      exhausted.load(Ordering::SeqCst),
      1,
      "domain terminalization hook must run exactly once before queue failure"
    );

    let _ = shutdown_tx.send(true);
    for handle in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), handle).await;
    }
    queue
      .clean_queue(qn, "failed", -1)
      .await
      .expect("clean failed retry-budget job");
  }

  // -----------------------------------------------------------------------
  // Test: concurrency limit is respected
  // -----------------------------------------------------------------------

  /// At most `concurrency` jobs must run at the same time.
  #[tokio::test]
  async fn worker_runtime_respects_concurrency_limit() {
    let queue = make_queue();
    let qn = "concurrency-test";

    // Enqueue 6 slow jobs.
    for i in 0..6u32 {
      queue
        .enqueue(qn, &format!("slow-{i}"), serde_json::json!({}), JobOptions::default())
        .await
        .expect("enqueue");
    }

    let concurrent_count = Arc::new(AtomicI32::new(0));
    let max_concurrent_seen = Arc::new(AtomicI32::new(0));

    let handler = SlowHandler {
      queue: qn.to_string(),
      sleep_ms: 200,
      concurrent_count: concurrent_count.clone(),
      max_concurrent_seen: max_concurrent_seen.clone(),
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime = WorkerRuntime::new(queue.clone(), fast_runtime_config(), shutdown_rx);
    runtime.register(
      handler,
      QueueConfig {
        concurrency: 2,
        ..Default::default()
      },
    );

    let handles = runtime.spawn();

    // Let several batches of 2 jobs complete.
    tokio::time::sleep(std::time::Duration::from_millis(1_400)).await;
    let _ = shutdown_tx.send(true);
    for h in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    }

    let peak = max_concurrent_seen.load(Ordering::SeqCst);
    assert!(
      peak <= 2,
      "max concurrent jobs ({peak}) must not exceed concurrency limit of 2"
    );
  }

  // -----------------------------------------------------------------------
  // Test WRK-RV-01c: concurrency actually processes jobs in parallel
  // -----------------------------------------------------------------------

  /// With concurrency=2 and 2 slow jobs (each ~200ms), total wall-clock time
  /// must be significantly less than 2×200ms, proving parallel execution.
  /// Additionally, the peak concurrent count must reach 2.
  #[tokio::test]
  async fn wrk_rv_01c_concurrency_processes_jobs_in_parallel() {
    let queue = make_queue();
    let qn = "parallel-test";

    // Enqueue exactly 2 slow jobs.
    for i in 0..2u32 {
      queue
        .enqueue(qn, &format!("par-{i}"), serde_json::json!({}), JobOptions::default())
        .await
        .expect("enqueue");
    }

    let concurrent_count = Arc::new(AtomicI32::new(0));
    let max_concurrent_seen = Arc::new(AtomicI32::new(0));
    let completed = Arc::new(AtomicI32::new(0));

    let handler = SlowHandler {
      queue: qn.to_string(),
      sleep_ms: 200,
      concurrent_count: concurrent_count.clone(),
      max_concurrent_seen: max_concurrent_seen.clone(),
    };

    let completed_clone = completed.clone();
    // Wrap SlowHandler to also count completions.
    struct CountingSlowHandler {
      inner: SlowHandler,
      completed: Arc<AtomicI32>,
    }

    #[async_trait::async_trait]
    impl JobHandler for CountingSlowHandler {
      fn queue_name(&self) -> &str {
        self.inner.queue_name()
      }
      async fn process(&self, job: &Job) -> Result<Option<serde_json::Value>, JobError> {
        let result = self.inner.process(job).await;
        self.completed.fetch_add(1, Ordering::SeqCst);
        result
      }
    }

    let counting_handler = CountingSlowHandler {
      inner: handler,
      completed: completed_clone,
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime = WorkerRuntime::new(queue.clone(), fast_runtime_config(), shutdown_rx);
    runtime.register(
      counting_handler,
      QueueConfig {
        concurrency: 2,
        ..Default::default()
      },
    );

    let start = std::time::Instant::now();
    let handles = runtime.spawn();

    // Wait until both jobs complete (poll every 50ms, timeout after 3s).
    let deadline = start + std::time::Duration::from_secs(3);
    while completed.load(Ordering::SeqCst) < 2 {
      assert!(
        std::time::Instant::now() < deadline,
        "timed out waiting for 2 jobs to complete"
      );
      tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let elapsed = start.elapsed();

    let _ = shutdown_tx.send(true);
    for h in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    }

    // Assertion 1: peak concurrent jobs must reach 2 (true parallelism).
    let peak = max_concurrent_seen.load(Ordering::SeqCst);
    assert_eq!(
      peak, 2,
      "peak concurrent jobs ({peak}) must reach 2, proving parallel execution"
    );

    // Assertion 2: total elapsed time must be well under 2×200ms = 400ms.
    // Allow generous headroom for CI slowness, but sequential would be >=400ms.
    assert!(
      elapsed < std::time::Duration::from_millis(380),
      "elapsed {:?} must be less than 380ms (sequential would be >=400ms)",
      elapsed
    );
  }

  // -----------------------------------------------------------------------
  // Test WRK-RV-03a: handler returning JobError::Permanent moves the job
  // into the BullMQ `failed` set and persists `failedReason`.
  //
  // This is the runtime-level twin of `queue::tests::fail_job_permanently_
  // moves_to_failed_set` — that test calls `queue.fail(...)` directly, this
  // one drives the handler→runtime→queue path end-to-end. A handler that
  // returns `Permanent("…")` must:
  //   * cause the job to leave `active`
  //   * land in `failed`
  //   * carry the operator-supplied error string in `failedReason`
  //
  // Backstop for P6 — the worker pipeline uses `Permanent` for the
  // ir/render/storage/timeout error classes, so an integration regression
  // here would silently strand pdf_export jobs in `active` forever.
  // -----------------------------------------------------------------------

  /// Handler that always returns `JobError::Permanent`. Counts invocations so
  /// the test can wait for the runtime to actually pick the job up before
  /// it inspects Redis.
  struct CrashingHandler {
    queue: String,
    invocations: Arc<AtomicI32>,
  }

  #[async_trait::async_trait]
  impl JobHandler for CrashingHandler {
    fn queue_name(&self) -> &str {
      &self.queue
    }
    async fn process(&self, _job: &Job) -> Result<Option<serde_json::Value>, JobError> {
      self.invocations.fetch_add(1, Ordering::SeqCst);
      Err(JobError::Permanent("intentional permanent failure".to_string()))
    }
  }

  #[tokio::test]
  async fn wrk_rv_03a_handler_permanent_error_marks_job_failed() {
    let queue = make_queue();
    let qn = "crash-test";

    queue
      .enqueue(qn, "doomed-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");

    let invocations = Arc::new(AtomicI32::new(0));
    let handler = CrashingHandler {
      queue: qn.to_string(),
      invocations: invocations.clone(),
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime = WorkerRuntime::new(queue.clone(), fast_runtime_config(), shutdown_rx);
    runtime.register(
      handler,
      QueueConfig {
        concurrency: 1,
        ..Default::default()
      },
    );

    let handles = runtime.spawn();

    // Wait until the runtime actually invoked the handler + had time to
    // record the failure in Redis. Poll the queue stats so the test stops
    // as soon as the assertion can be answered, without burning a fixed
    // sleep budget.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut failed_count = 0i64;
    while std::time::Instant::now() < deadline {
      if invocations.load(Ordering::SeqCst) >= 1 {
        let stats = queue.queue_stats(qn).await.expect("queue_stats");
        failed_count = stats.failed;
        if failed_count >= 1 {
          break;
        }
      }
      tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let _ = shutdown_tx.send(true);
    for h in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    }

    assert_eq!(
      invocations.load(Ordering::SeqCst),
      1,
      "handler must have been invoked exactly once before the permanent error"
    );
    assert_eq!(
      failed_count, 1,
      "permanent handler error must move the job into the BullMQ `failed` set"
    );

    // Verify the failedReason was actually persisted with the operator
    // string — empty strings would silently swallow the diagnostic.
    let (failed_jobs, _total) = queue.list_jobs(qn, "failed", 0, 10).await.expect("list_jobs(failed)");
    let reason = failed_jobs
      .into_iter()
      .next()
      .and_then(|v| v.get("failedReason").and_then(|r| r.as_str()).map(str::to_string))
      .unwrap_or_default();
    assert!(
      reason.contains("intentional permanent failure"),
      "failedReason must be persisted from the handler error, got: {reason:?}"
    );
  }

  // -----------------------------------------------------------------------
  // Test WRK-RV-03b: per-queue isolation — a busy queue must not stall
  // others. Each queue gets its own `tokio::sync::Semaphore` and its own
  // dequeue loop, so a long-running handler on queue A may not delay queue
  // B's handler.
  //
  // Setup:
  //   - queue A: 1 SlowHandler job (sleep 800ms), concurrency=1 → queue A
  //     stays busy for the full sleep window.
  //   - queue B: 1 FastHandler job (returns immediately), concurrency=1 →
  //     B must finish well before A.
  //
  // Assertion: B's elapsed time from `runtime.spawn()` to handler completion
  // is < 400ms (half of A's 800ms sleep). Sequential dispatch would push B
  // to ≥800ms.
  //
  // This pins the P6 expectation that a slow `pdf-export` render cannot
  // starve other workers (e.g. `notification`, `git-sync`).
  // -----------------------------------------------------------------------

  struct FastHandler {
    queue: String,
    started_at: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
    done_at: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
  }

  #[async_trait::async_trait]
  impl JobHandler for FastHandler {
    fn queue_name(&self) -> &str {
      &self.queue
    }
    async fn process(&self, _job: &Job) -> Result<Option<serde_json::Value>, JobError> {
      *self.started_at.lock().expect("started_at poisoned") = Some(std::time::Instant::now());
      *self.done_at.lock().expect("done_at poisoned") = Some(std::time::Instant::now());
      Ok(None)
    }
  }

  #[tokio::test]
  async fn wrk_rv_03b_per_queue_isolation_busy_queue_does_not_block_others() {
    let queue = make_queue();
    let slow_qn = "iso-slow";
    let fast_qn = "iso-fast";

    queue
      .enqueue(slow_qn, "slow", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue slow");
    queue
      .enqueue(fast_qn, "fast", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue fast");

    let slow_concurrent = Arc::new(AtomicI32::new(0));
    let slow_peak = Arc::new(AtomicI32::new(0));
    let slow_handler = SlowHandler {
      queue: slow_qn.to_string(),
      sleep_ms: 800,
      concurrent_count: slow_concurrent,
      max_concurrent_seen: slow_peak,
    };

    let fast_started: Arc<std::sync::Mutex<Option<std::time::Instant>>> = Arc::new(std::sync::Mutex::new(None));
    let fast_done: Arc<std::sync::Mutex<Option<std::time::Instant>>> = Arc::new(std::sync::Mutex::new(None));
    let fast_handler = FastHandler {
      queue: fast_qn.to_string(),
      started_at: fast_started.clone(),
      done_at: fast_done.clone(),
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut runtime = WorkerRuntime::new(queue.clone(), fast_runtime_config(), shutdown_rx);
    runtime.register(
      slow_handler,
      QueueConfig {
        concurrency: 1,
        ..Default::default()
      },
    );
    runtime.register(
      fast_handler,
      QueueConfig {
        concurrency: 1,
        ..Default::default()
      },
    );

    let spawn_at = std::time::Instant::now();
    let handles = runtime.spawn();

    // Wait for the fast handler to finish, polling every 25ms with a hard
    // 1.5s ceiling. If isolation is broken the slow queue holds up B for
    // ~800ms; the assertion below catches that.
    let deadline = spawn_at + std::time::Duration::from_millis(1_500);
    while fast_done.lock().expect("fast_done poisoned").is_none() {
      assert!(
        std::time::Instant::now() < deadline,
        "fast queue handler never ran — per-queue isolation appears broken"
      );
      tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let fast_finish_elapsed = fast_done
      .lock()
      .expect("fast_done poisoned")
      .expect("fast handler must have completed")
      .duration_since(spawn_at);

    let _ = shutdown_tx.send(true);
    for h in handles {
      let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    }

    // The fast handler must finish well before the 800ms slow window —
    // 400ms gives generous CI headroom (Redis round-trips + spawn lag) but
    // is still firmly inside the "queues are isolated" regime.
    assert!(
      fast_finish_elapsed < std::time::Duration::from_millis(400),
      "fast queue handler finished after {fast_finish_elapsed:?}, expected <400ms — \
       slow queue appears to be blocking other queues"
    );
  }
}
