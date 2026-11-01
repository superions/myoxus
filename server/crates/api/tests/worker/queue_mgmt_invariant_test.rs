//! Queue management invariant tests (BF-SRV-04o) — Redis-level.
//!
//! These tests verify RedisQueue management operations directly against a
//! real Redis instance. They do NOT require PostgreSQL.
//!
//! Requirements:
//!   - Redis at TEST_REDIS_URL or REDIS_URL (default: redis://127.0.0.1:6380)
//!
//! Run:
//!   TEST_REDIS_URL=redis://127.0.0.1:6380 cargo test -p myoxus-api --test integration queue_mgmt_invariant_test

use myoxus_worker::{TerminalRetentionPolicy, job::JobOptions, queue::RedisQueue};
use serde_json::json;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn redis_url() -> String {
  std::env::var("TEST_REDIS_URL")
    .or_else(|_| std::env::var("REDIS_URL"))
    .unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string())
}

/// Build a RedisQueue with a unique per-test prefix for full isolation.
fn make_queue() -> RedisQueue {
  let prefix = format!("test-mgmt-{}", Uuid::new_v4().as_simple());
  RedisQueue::new(&redis_url(), prefix).expect("RedisQueue::new")
}

/// Clean up all Redis keys created by a test queue.
async fn cleanup(q: &RedisQueue, qn: &str) {
  // Access prefix via Debug output since it's not pub — use a known pattern.
  // RedisQueue stores keys as `{prefix}:{queue}:*`.
  let client = redis::Client::open(redis_url().as_str()).expect("DB operation");
  let mut conn = client.get_multiplexed_async_connection().await.expect("DB operation");
  // We rely on the queue's own key method via stats/operations being done.
  // Since prefix is random UUID, just scan for test-mgmt-* pattern.
  let dbg = format!("{:?}", q);
  // Extract prefix from Debug: RedisQueue { prefix: "test-mgmt-..." }
  if let Some(start) = dbg.find('"')
    && let Some(end) = dbg[start + 1..].find('"')
  {
    let prefix = &dbg[start + 1..start + 1 + end];
    let pattern = format!("{prefix}:{qn}:*");
    let keys: Vec<String> = redis::cmd("KEYS")
      .arg(&pattern)
      .query_async(&mut conn)
      .await
      .unwrap_or_default();
    if !keys.is_empty() {
      let _: () = redis::cmd("DEL").arg(&keys).query_async(&mut conn).await.unwrap_or(());
    }
  }
}

/// Skip test if Redis is unreachable.
async fn require_redis() -> bool {
  let client = match redis::Client::open(redis_url().as_str()) {
    Ok(c) => c,
    Err(_) => return false,
  };
  match client.get_multiplexed_async_connection().await {
    Ok(mut conn) => redis::cmd("PING").query_async::<String>(&mut conn).await.is_ok(),
    Err(_) => false,
  }
}

macro_rules! skip_no_redis {
  () => {
    if !require_redis().await {
      eprintln!("SKIP: Redis not available at {}", redis_url());
      return;
    }
  };
}

// ---------------------------------------------------------------------------
// inv_queue01: pause_queue sets redis flag, is_paused returns true
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue01_pause_sets_redis_flag() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q01";

  q.pause_queue(qn).await.expect("pause");
  assert!(
    q.is_paused(qn).await.expect("is_paused"),
    "queue must be paused after pause_queue"
  );

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue02: resume_queue clears paused flag
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue02_resume_clears_flag() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q02";

  q.pause_queue(qn).await.expect("pause");
  assert!(q.is_paused(qn).await.expect("is_paused"));
  q.resume_queue(qn).await.expect("resume");
  assert!(
    !q.is_paused(qn).await.expect("is_paused"),
    "queue must not be paused after resume"
  );

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue03: clean_queue removes old completed jobs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue03_clean_removes_old_completed() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q03";

  // Enqueue, dequeue, ack to create a completed job.
  let _id = q
    .enqueue(qn, "old-job", json!({}), JobOptions::default())
    .await
    .expect("DB operation");
  let job = q.dequeue(qn, 1).await.expect("DB operation").expect("DB operation");
  q.ack(
    qn,
    &job.id,
    None,
    TerminalRetentionPolicy {
      remove_on_complete: false,
      ..TerminalRetentionPolicy::default()
    },
  )
  .await
  .expect("DB operation");

  // Wait 10ms so finishedOn is in the past, then clean with grace=0.
  tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  let removed = q.clean_queue(qn, "completed", 0).await.expect("DB operation");
  assert_eq!(removed, 1, "one completed job must be cleaned");

  let stats = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats.completed, 0, "completed set must be empty after clean");

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue04: empty_queue clears wait and delayed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue04_empty_clears_wait_and_delayed() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q04";

  // Add a waiting job and a delayed job.
  q.add_job(qn, "wait-job", json!({}), None).await.expect("DB operation");
  q.add_job(qn, "delayed-job", json!({}), Some(60_000))
    .await
    .expect("DB operation");

  let stats_before = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats_before.waiting, 1);
  assert_eq!(stats_before.delayed, 1);

  let emptied = q.empty_queue(qn).await.expect("DB operation");
  assert_eq!(emptied, 2, "empty must remove both waiting and delayed jobs");

  let stats_after = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats_after.waiting, 0, "wait list must be empty");
  assert_eq!(stats_after.delayed, 0, "delayed set must be empty");

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue05: retry_job moves failed job to wait
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue05_retry_moves_failed_to_wait() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q05";

  // Enqueue, dequeue, fail permanently.
  q.enqueue(qn, "fail-job", json!({}), JobOptions::default())
    .await
    .expect("DB operation");
  let job = q.dequeue(qn, 1).await.expect("DB operation").expect("DB operation");
  q.fail(qn, &job.id, "broken", None, TerminalRetentionPolicy::default())
    .await
    .expect("DB operation");

  let stats = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats.failed, 1, "job must be in failed set before retry");

  q.retry_job(qn, &job.id).await.expect("DB operation");
  let stats_after = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats_after.failed, 0, "failed set must be empty after retry");
  assert_eq!(stats_after.waiting, 1, "job must be back in wait list");

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue06: promote_job moves delayed job to wait
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue06_promote_moves_delayed_to_wait() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q06";

  // Add a delayed job (far future).
  let id = q
    .add_job(qn, "delayed-job", json!({}), Some(600_000))
    .await
    .expect("DB operation");

  let stats = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats.delayed, 1, "job must be in delayed set");
  assert_eq!(stats.waiting, 0);

  q.promote_job(qn, &id).await.expect("DB operation");
  let stats_after = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats_after.delayed, 0, "delayed set must be empty after promote");
  assert_eq!(stats_after.waiting, 1, "promoted job must be in wait list");

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue07: get_job returns correct data
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue07_get_job_returns_data() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q07";

  let data = json!({"key": "value", "n": 42});
  let id = q
    .add_job(qn, "test-job", data.clone(), None)
    .await
    .expect("DB operation");

  let job = q.get_job(qn, &id).await.expect("DB operation").expect("job must exist");
  assert_eq!(job.id, id);
  assert_eq!(job.name, "test-job");
  assert_eq!(job.data["key"], "value");
  assert_eq!(job.data["n"], 42);
  assert_eq!(job.attempts_made, 0);

  cleanup(&q, qn).await;
}

// ---------------------------------------------------------------------------
// inv_queue08: add_job with delay goes to delayed set
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_queue08_add_job_with_delay_goes_to_delayed() {
  skip_no_redis!();
  let q = make_queue();
  let qn = "q08";

  q.add_job(qn, "delayed", json!({}), Some(30_000))
    .await
    .expect("DB operation");

  let stats = q.queue_stats(qn).await.expect("DB operation");
  assert_eq!(stats.delayed, 1, "job with delay must be in delayed set");
  assert_eq!(stats.waiting, 0, "delayed job must not be in wait list");

  cleanup(&q, qn).await;
}
