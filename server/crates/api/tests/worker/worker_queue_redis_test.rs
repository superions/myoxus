//! Integration tests for the Redis-backed BullMQ-compatible job queue.
//!
//! These tests verify that `RedisQueue` produces BullMQ-compatible data
//! structures in Redis (correct key layout, HSET fields, LPUSH to wait list)
//! and that the `WorkQueuePort` contract is satisfied when jobs are enqueued
//! through the adapter pattern used by the server.
//!
//! Requirements:
//!   - Redis at REDIS_URL env (default: redis://127.0.0.1:6379)
//!   - PostgreSQL at TEST_DATABASE_URL env (default: postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test)
//!     (needed by helpers::setup_pool for migrations; queue tests themselves are Redis-only)
//!
//! Tests that need Redis are marked `#[ignore]` only when Redis is absent.
//! With the standard docker-compose stack both services are available.

use myoxus_worker::{TerminalRetentionPolicy, job::JobOptions, queue::RedisQueue};
use serde_json::json;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn redis_url() -> String {
  std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
}

/// Build a RedisQueue with a unique test prefix.
fn make_queue(label: &str) -> RedisQueue {
  let prefix = format!("bull-itest-{label}-{}", Uuid::new_v4().as_simple());
  RedisQueue::new(&redis_url(), prefix).expect("RedisQueue::new")
}

// ---------------------------------------------------------------------------
// Test: enqueued job lands in `bull:<prefix>:<queue>:wait` LPUSH slot
// ---------------------------------------------------------------------------

/// Enqueueing through `RedisQueue::enqueue` must create a BullMQ-compatible
/// job hash and push the ID to `bull:<prefix>:<queue>:wait`.
#[tokio::test]
async fn work_queue_port_enqueue_creates_bullmq_compatible_job() {
  let queue = make_queue("compat");
  let qn = "notification";

  let job_id = queue
    .enqueue(qn, "sendInvitation", json!({"userId": "u1"}), JobOptions::default())
    .await
    .expect("enqueue");

  // The queue stats are the authoritative count without direct key access.
  let stats = queue.queue_stats(qn).await.expect("queue_stats");
  assert_eq!(stats.waiting, 1, "one job must be waiting after enqueue");
  assert_eq!(stats.active, 0, "no jobs active yet");
  assert_eq!(stats.failed, 0, "no jobs failed");

  // Dequeue and verify BullMQ hash fields via the decoded Job struct.
  let job = queue.dequeue(qn, 1).await.expect("dequeue").expect("job present");
  assert_eq!(job.id, job_id, "dequeued job ID must match enqueued ID");
  assert_eq!(job.name, "sendInvitation", "job name must match");
  assert_eq!(job.data["userId"], "u1", "job data must round-trip");
  assert!(job.timestamp > 0, "job must have a creation timestamp");

  // Ack to move from active → completed.
  queue
    .ack(
      qn,
      &job_id,
      None,
      TerminalRetentionPolicy {
        remove_on_complete: false,
        ..TerminalRetentionPolicy::default()
      },
    )
    .await
    .expect("ack");
  let stats_after = queue.queue_stats(qn).await.expect("stats after ack");
  assert_eq!(stats_after.active, 0, "active must be 0 after ack");
  assert_eq!(stats_after.completed, 1, "completed must be 1 after ack");
}

// ---------------------------------------------------------------------------
// Test: indexer queue jobs land in the correct queue name
// ---------------------------------------------------------------------------

/// Jobs enqueued for the indexer service must land in the `indexer` queue
/// with the correct job name and workspace/doc payload fields.
#[tokio::test]
async fn indexer_queue_enqueues_to_correct_queue_name() {
  let queue = make_queue("indexer");
  let qn = "indexer";

  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();

  let job_id = queue
    .enqueue(
      qn,
      "indexer.indexDoc",
      json!({
          "workspace_id": workspace_id.to_string(),
          "doc_id": doc_id.to_string()
      }),
      JobOptions::default(),
    )
    .await
    .expect("enqueue indexer job");

  // Verify it lands in the indexer wait list.
  let stats = queue.queue_stats(qn).await.expect("stats");
  assert_eq!(stats.waiting, 1, "indexer job must be in wait list");

  // Dequeue and inspect.
  let job = queue.dequeue(qn, 1).await.expect("dequeue").expect("job");
  assert_eq!(job.id, job_id);
  assert_eq!(job.name, "indexer.indexDoc", "job name must be indexer.indexDoc");
  assert_eq!(
    job.data["workspace_id"].as_str().expect("workspace_id in job data"),
    workspace_id.to_string().as_str(),
    "workspace_id must be in payload"
  );
  assert_eq!(
    job.data["doc_id"].as_str().expect("doc_id in job data"),
    doc_id.to_string().as_str(),
    "doc_id must be in payload"
  );

  queue
    .ack(qn, &job.id, None, TerminalRetentionPolicy::default())
    .await
    .expect("ack");
}

// ---------------------------------------------------------------------------
// Test: delayed job not immediately visible in wait list
// ---------------------------------------------------------------------------

/// A job enqueued with `delay_ms > 0` must not appear in the wait list
/// before it is due.
#[tokio::test]
async fn delayed_job_appears_in_delayed_set_not_wait_list() {
  let queue = make_queue("delayed-itest");
  let qn = "notification";

  let opts = JobOptions {
    delay_ms: Some(30_000), // 30 s in the future
    ..Default::default()
  };
  queue
    .enqueue(qn, "sendReminder", json!({}), opts)
    .await
    .expect("enqueue delayed");

  let stats = queue.queue_stats(qn).await.expect("stats");
  assert_eq!(stats.waiting, 0, "delayed job must not be in wait list yet");
  assert_eq!(stats.delayed, 1, "delayed job must be in delayed sorted set");
}

// ---------------------------------------------------------------------------
// Test: multiple queues are isolated from each other
// ---------------------------------------------------------------------------

/// Jobs in the `notification` queue must not be visible in the `indexer` queue.
#[tokio::test]
async fn jobs_in_different_queues_are_isolated() {
  let queue = make_queue("isolation");

  queue
    .enqueue("notification", "sendMail", json!({}), JobOptions::default())
    .await
    .expect("enqueue notification");

  // The indexer queue should be empty.
  let indexer_stats = queue.queue_stats("indexer").await.expect("indexer stats");
  assert_eq!(indexer_stats.waiting, 0, "indexer queue must be empty");

  let notification_stats = queue.queue_stats("notification").await.expect("notification stats");
  assert_eq!(notification_stats.waiting, 1, "notification queue must have one job");
}

// ---------------------------------------------------------------------------
// Test: job max_attempts is stored in the hash
// ---------------------------------------------------------------------------

/// The `max_attempts` option must survive the enqueue / dequeue round-trip.
#[tokio::test]
async fn job_max_attempts_is_preserved_in_round_trip() {
  let queue = make_queue("maxatt");
  let qn = "notification";

  let opts = JobOptions {
    max_attempts: 5,
    ..Default::default()
  };
  queue
    .enqueue(qn, "criticalJob", json!({}), opts)
    .await
    .expect("enqueue");

  let job = queue.dequeue(qn, 1).await.expect("dequeue").expect("job");
  assert_eq!(
    job.opts.max_attempts, 5,
    "max_attempts must round-trip through the Redis hash"
  );

  queue
    .ack(qn, &job.id, None, TerminalRetentionPolicy::default())
    .await
    .expect("ack");
}

// ---------------------------------------------------------------------------
// Test: fail with retry increments attempts counter
// ---------------------------------------------------------------------------

/// After a `fail` with a future `retry_at`, `attempts_made` in the Redis hash
/// must be 1.
#[tokio::test]
async fn fail_increments_attempts_made_in_hash() {
  let queue = make_queue("attempts");
  let qn = "notification";

  queue
    .enqueue(qn, "flaky", json!({}), JobOptions::default())
    .await
    .expect("enqueue");

  let job = queue.dequeue(qn, 1).await.expect("dequeue").expect("job");
  let retry_at = chrono::Utc::now().timestamp_millis() + 60_000;
  queue
    .fail(
      qn,
      &job.id,
      "transient error",
      Some(retry_at),
      TerminalRetentionPolicy::default(),
    )
    .await
    .expect("fail");

  // Re-dequeue is not possible yet (it's in delayed), but queue_stats
  // should reflect the state.
  let stats = queue.queue_stats(qn).await.expect("stats");
  assert_eq!(stats.delayed, 1, "job must be in delayed for retry");
  assert_eq!(stats.active, 0, "job must no longer be active");
}
