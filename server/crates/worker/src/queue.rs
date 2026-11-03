//! Redis queue operations implementing BullMQ-compatible data structures.
//!
//! Key layout follows BullMQ conventions:
//! - `bull:<queue>:wait` — List of job IDs waiting to be processed
//! - `bull:<queue>:active` — List of job IDs currently being processed
//! - `bull:<queue>:completed` — Set of completed job IDs
//! - `bull:<queue>:failed` — Set of failed job IDs
//! - `bull:<queue>:failed-retention` — Sorted set indexing permanent failure time
//! - `bull:<queue>:delayed` — Sorted set of delayed jobs (score = run-at timestamp ms)
//! - `bull:<queue>:stalled` — Set of stalled job IDs
//! - `bull:<queue>:id` — Auto-incrementing job ID counter
//! - `bull:<queue>:<jobId>` — Hash containing job data
//! - `bull:<queue>:meta` — Hash containing queue metadata

use chrono::Utc;
use redis::AsyncCommands;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tracing::{debug, info, instrument, trace, warn};

use crate::TerminalRetentionPolicy;
use crate::job::{Job, JobOptions};
use crate::metrics::{QueueHistoryPoint, QueueStats};

const TERMINAL_RETENTION_PRUNE_BATCH: i64 = 2_000;

/// Error type for queue operations.
#[derive(Debug, thiserror::Error)]
pub enum QueueError {
  /// Redis communication failure.
  #[error("redis error: {0}")]
  Redis(#[from] redis::RedisError),
  /// Serialization/deserialization failure.
  #[error("serialization error: {0}")]
  Serialization(String),
  /// Job not found.
  #[error("job not found: queue={queue} id={id}")]
  NotFound { queue: String, id: String },
  /// An idempotency key was reused for different work.
  #[error("job idempotency conflict: queue={queue} id={id}")]
  IdempotencyConflict { queue: String, id: String },
}

/// Result type for queue operations.
pub type QueueResult<T> = Result<T, QueueError>;

/// Redis-backed job queue with BullMQ-compatible data structures.
#[derive(Clone)]
pub struct RedisQueue {
  client: redis::Client,
  /// One reconnecting command connection shared by all queue clones.
  command_connection: Arc<OnceCell<redis::aio::ConnectionManager>>,
  /// Key prefix (e.g. `"bull"` or `"myoxus:queue:bull"`).
  prefix: String,
}

impl RedisQueue {
  /// Enqueue the frozen future slot accepted by shared SQL timing. Replays use
  /// the same native job ID; enqueue_idempotent preserves an existing job's
  /// attempts/backoff/lease even when the remaining delay has changed.
  #[instrument(skip_all,fields(dispatch_id=%delivery.dispatch_id))]
  pub async fn enqueue_registered(
    &self,
    delivery: &myoxus_domain::scheduling::registered::RegisteredDispatch,
  ) -> QueueResult<()> {
    let remaining = delivery
      .scheduled_for
      .timestamp_millis()
      .saturating_sub(Utc::now().timestamp_millis());
    self
      .enqueue_idempotent(
        delivery.job.queue(),
        &delivery.job_id(),
        delivery.job.name(),
        delivery.data.clone(),
        JobOptions {
          delay_ms: (remaining > 0).then_some(remaining),
          ..JobOptions::default()
        },
      )
      .await?;
    Ok(())
  }
  /// Replace a minute atomically across instances, retain at most 24 hours,
  /// and expire inactive histories without touching job or queue metadata.
  pub async fn record_history(&self, stats: &QueueStats, timestamp: i64) -> QueueResult<()> {
    let Some(point) = stats.history_point(timestamp) else {
      return Ok(());
    };
    let mut conn = self.connection().await?;
    let payload = serde_json::to_string(&point).map_err(|err| QueueError::Serialization(err.to_string()))?;
    redis::Script::new(
      r#"
      redis.call('ZREMRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[1])
      redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[3])
      redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -1442)
      redis.call('EXPIRE', KEYS[1], 90000)
      return 1
    "#,
    )
    .key(self.key(&stats.queue, "history"))
    .arg(point.timestamp)
    .arg(payload)
    .arg(point.timestamp - 86_400_000)
    .invoke_async::<i64>(&mut conn)
    .await?;
    Ok(())
  }

  /// Failed reads never become synthetic zeroes. Both window and size are bounded.
  pub async fn history(&self, queue: &str, now: i64) -> QueueResult<Vec<QueueHistoryPoint>> {
    let mut conn = self.connection().await?;
    let values: Vec<String> = redis::cmd("ZRANGEBYSCORE")
      .arg(self.key(queue, "history"))
      .arg(now.saturating_sub(86_400_000))
      .arg(now)
      .arg("LIMIT")
      .arg(0)
      .arg(1441)
      .query_async(&mut conn)
      .await?;
    values
      .into_iter()
      .map(|value| serde_json::from_str(&value).map_err(|err| QueueError::Serialization(err.to_string())))
      .collect()
  }

  /// Construct a `RedisQueue` from a Redis URL and key prefix.
  pub fn new(url: &str, prefix: impl Into<String>) -> QueueResult<Self> {
    let client = redis::Client::open(url)?;
    Ok(Self {
      client,
      command_connection: Arc::new(OnceCell::new()),
      prefix: prefix.into(),
    })
  }

  /// Construct a `RedisQueue` from the startup-owned Redis role client.
  /// Production composition uses this path so queue, scheduler and reconnects
  /// retain the same verified TLS trust as readiness and cache consumers.
  pub fn from_client(client: redis::Client, prefix: impl Into<String>) -> Self {
    Self {
      client,
      command_connection: Arc::new(OnceCell::new()),
      prefix: prefix.into(),
    }
  }

  async fn connection(&self) -> QueueResult<redis::aio::ConnectionManager> {
    let manager = self
      .command_connection
      .get_or_try_init(|| async {
        let config = redis::aio::ConnectionManagerConfig::new().set_number_of_retries(0);
        self.client.get_connection_manager_with_config(config).await
      })
      .await?;
    Ok(manager.clone())
  }

  fn key(&self, queue: &str, suffix: &str) -> String {
    format!("{}:{}:{}", self.prefix, queue, suffix)
  }

  fn job_key(&self, queue: &str, job_id: &str) -> String {
    format!("{}:{}:{}", self.prefix, queue, job_id)
  }

  /// Retire only the old Calendar enqueue scan after its SQL transfer. Deployment
  /// requires an all-instance stop: an interrupted scan owns no delivery receipt
  /// and may be discarded, whereas actual processReminder jobs remain untouched.
  /// Reads are bounded to this one queue; interruption resumes idempotently.
  #[instrument(skip_all)]
  pub async fn retire_calendar_reminder_enqueue_tick(&self) -> QueueResult<usize> {
    self
      .retire_reminder_tick("calendar-reminder", "calendar.enqueueReminders")
      .await
  }

  /// Pending notification.sendDatabaseRowReminder deliveries live on their
  /// existing notification queue and are not part of this retired timing tick.
  #[instrument(skip_all)]
  pub async fn retire_database_reminder_fire_tick(&self) -> QueueResult<usize> {
    self.retire_reminder_tick("database", "database.fireReminders").await
  }

  /// Called only after the controlled native timing transfer. Keep real Git
  /// Run and rotation jobs, including in-progress/retrying native attempts.
  #[instrument(skip_all)]
  pub async fn retire_git_sync_schedule_tick(&self) -> QueueResult<usize> {
    self.retire_reminder_tick("git-sync", "git-sync.scheduleTick").await
  }

  async fn retire_reminder_tick(&self, queue: &str, job: &str) -> QueueResult<usize> {
    const LIMIT: isize = 100_000;
    let mut conn = self.connection().await?;
    let wait = self.key(queue, "wait");
    let active = self.key(queue, "active");
    let delayed = self.key(queue, "delayed");
    let repeat_prefix = format!("repeat:{job}:");
    let mut ids = std::collections::BTreeSet::<String>::new();
    for key in [&wait, &active] {
      let rows: Vec<String> = conn.lrange(key, 0, LIMIT).await?;
      if rows.len() > LIMIT as usize {
        return Err(QueueError::Serialization(
          "Reminder tick retirement budget exceeded".into(),
        ));
      }
      ids.extend(rows);
    }
    let rows: Vec<String> = conn.zrange(&delayed, 0, LIMIT).await?;
    ids.extend(rows);
    if ids.len() > LIMIT as usize {
      return Err(QueueError::Serialization(
        "Reminder tick retirement budget exceeded".into(),
      ));
    }
    let ids = ids.into_iter().collect::<Vec<_>>();
    let mut pending = Vec::new();
    for chunk in ids.chunks(256) {
      let mut pipe = redis::pipe();
      for id in chunk {
        pipe.cmd("HGET").arg(self.job_key(queue, id)).arg("name");
      }
      let names: Vec<Option<String>> = pipe.query_async(&mut conn).await?;
      for (id, name) in chunk.iter().zip(names) {
        if name.as_deref() != Some(job) {
          continue;
        }
        let opts: Option<String> = conn.hget(self.job_key(queue, id), "opts").await?;
        let opts = opts.ok_or_else(|| QueueError::Serialization("Retired reminder tick options missing".into()))?;
        let shape: serde_json::Value = serde_json::from_str(&opts)
          .map_err(|_| QueueError::Serialization("Retired reminder tick options invalid".into()))?;
        let repeat = shape["repeat"]["job_id"]
          .as_str()
          .ok_or_else(|| QueueError::Serialization("Retired reminder tick repeat identity missing".into()))?;
        let slot = repeat
          .strip_prefix(repeat_prefix.as_str())
          .and_then(|value| value.parse::<u64>().ok());
        if slot.is_none() {
          return Err(QueueError::Serialization(
            "Retired reminder tick repeat identity invalid".into(),
          ));
        }
        pending.push((id.clone(), opts));
      }
    }
    let remove = redis::Script::new(
      r#"
      if redis.call('HGET',KEYS[1],'name')~=ARGV[1] then return 0 end
      if redis.call('HGET',KEYS[1],'opts')~=ARGV[2] then return 0 end
      redis.call('LREM',KEYS[2],0,ARGV[3]); redis.call('LREM',KEYS[3],0,ARGV[3])
      redis.call('ZREM',KEYS[4],ARGV[3]); redis.call('DEL',KEYS[1]); return 1
    "#,
    );
    let mut removed = 0;
    for (id, opts) in pending {
      let count: i64 = remove
        .key(self.job_key(queue, &id))
        .key(&wait)
        .key(&active)
        .key(&delayed)
        .arg(job)
        .arg(opts)
        .arg(&id)
        .invoke_async(&mut conn)
        .await?;
      match count {
        1 => removed += 1,
        0 => {
          let name: Option<String> = conn.hget(self.job_key(queue, &id), "name").await?;
          if name.as_deref() == Some(job) {
            return Err(QueueError::Serialization(
              "Retired reminder tick changed during transfer".into(),
            ));
          }
        }
        _ => {
          return Err(QueueError::Serialization(
            "Retired reminder tick acknowledgement invalid".into(),
          ));
        }
      }
    }
    // Tracking is deliberately unprefixed in the deployed repeat scheduler.
    let _: usize = conn.del(format!("cron:{queue}:{job}")).await?;
    Ok(removed)
  }

  fn terminal_retention_key(&self, queue: &str, status: &str) -> String {
    self.key(queue, &format!("{status}-retention"))
  }

  /// Enqueue a new job into the wait list.
  ///
  /// Returns the assigned job ID.
  #[instrument(skip(self, data, opts))]
  pub async fn enqueue(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    opts: JobOptions,
  ) -> QueueResult<String> {
    let mut conn = self.connection().await?;
    let id_key = self.key(queue, "id");

    // Atomically increment job ID counter
    let id: i64 = conn.incr(&id_key, 1i64).await?;
    let job_id = id.to_string();
    let now_ms = Utc::now().timestamp_millis();

    let job = Job {
      id: job_id.clone(),
      name: job_name.to_string(),
      data: data.clone(),
      opts: opts.clone(),
      timestamp: now_ms,
      attempts_made: 0,
      finished_on: None,
      failed_reason: None,
      heartbeat: None,
      return_value: None,
    };

    let job_json = serde_json::to_string(&job).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let data_json = serde_json::to_string(&data).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let opts_json = serde_json::to_string(&opts).map_err(|e| QueueError::Serialization(e.to_string()))?;

    let job_hash_key = self.job_key(queue, &job_id);

    // WRK-RV-02: Store job hash AND push to wait/delayed in one atomic pipeline.
    // Without atomic execution, a failure between HSET and LPUSH/ZADD leaves
    // an orphaned job hash in Redis.
    let mut pipe = redis::pipe();
    pipe
      .atomic()
      .cmd("HSET")
      .arg(&job_hash_key)
      .arg("name")
      .arg(job_name)
      .arg("data")
      .arg(&data_json)
      .arg("opts")
      .arg(&opts_json)
      .arg("timestamp")
      .arg(now_ms)
      .arg("attemptsMade")
      .arg(0i32)
      .arg("_json")
      .arg(&job_json)
      .ignore();

    if let Some(delay_ms) = opts.delay_ms {
      let delayed_key = self.key(queue, "delayed");
      let run_at = now_ms + delay_ms;
      pipe.zadd(&delayed_key, &job_id, run_at as f64).ignore();
      debug!(queue, job_id, delay_ms, run_at, "job enqueued to delayed set");
    } else {
      let wait_key = self.key(queue, "wait");
      pipe.lpush(&wait_key, &job_id).ignore();
      debug!(queue, job_id, "job enqueued to wait list");
    }

    pipe.query_async::<redis::Value>(&mut conn).await?;

    Ok(job_id)
  }

  /// Enqueue one recoverable job under a caller-owned stable identifier.
  ///
  /// Replaying the same identifier and payload is idempotent. If the prior job
  /// failed before the durable owner was claimed, it is reset and queued again.
  /// Completed jobs and identifiers reused for different work fail closed so
  /// replay cannot duplicate side effects.
  #[instrument(skip(self, data, opts), fields(queue, job_id))]
  pub async fn enqueue_idempotent(
    &self,
    queue: &str,
    job_id: &str,
    job_name: &str,
    data: serde_json::Value,
    opts: JobOptions,
  ) -> QueueResult<(String, bool)> {
    let mut conn = self.connection().await?;
    let now_ms = Utc::now().timestamp_millis();
    let job = Job {
      id: job_id.to_string(),
      name: job_name.to_string(),
      data: data.clone(),
      opts: opts.clone(),
      timestamp: now_ms,
      attempts_made: 0,
      finished_on: None,
      failed_reason: None,
      heartbeat: None,
      return_value: None,
    };
    let job_json = serde_json::to_string(&job).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let data_json = serde_json::to_string(&data).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let opts_json = serde_json::to_string(&opts).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let run_at = opts.delay_ms.map(|delay| now_ms + delay).unwrap_or(0);

    let script = redis::Script::new(
      r#"
      local job_exists = redis.call('EXISTS', KEYS[1])
      if job_exists == 1 then
        if redis.call('HGET', KEYS[1], 'name') ~= ARGV[2]
          or redis.call('HGET', KEYS[1], 'data') ~= ARGV[3] then
          return -1
        end
        if redis.call('SISMEMBER', KEYS[5], ARGV[1]) == 1 then
          return -1
        end
        if redis.call('LPOS', KEYS[2], ARGV[1])
          or redis.call('LPOS', KEYS[3], ARGV[1])
          or redis.call('ZSCORE', KEYS[4], ARGV[1]) then
          return 0
        end
      end

      redis.call('SREM', KEYS[6], ARGV[1])
      redis.call('SREM', KEYS[7], ARGV[1])
      redis.call('ZREM', KEYS[8], ARGV[1])
      redis.call('HSET', KEYS[1],
        'name', ARGV[2],
        'data', ARGV[3],
        'opts', ARGV[4],
        'timestamp', ARGV[5],
        'attemptsMade', 0,
        '_json', ARGV[6])
      redis.call('HDEL', KEYS[1], 'finishedOn', 'failedReason', 'returnvalue', 'heartbeat')
      if tonumber(ARGV[7]) > 0 then
        redis.call('ZADD', KEYS[4], ARGV[7], ARGV[1])
      else
        redis.call('LPUSH', KEYS[2], ARGV[1])
      end
      return 1
      "#,
    );
    let outcome: i64 = script
      .key(self.job_key(queue, job_id))
      .key(self.key(queue, "wait"))
      .key(self.key(queue, "active"))
      .key(self.key(queue, "delayed"))
      .key(self.key(queue, "completed"))
      .key(self.key(queue, "failed"))
      .key(self.key(queue, "stalled"))
      .key(self.terminal_retention_key(queue, "failed"))
      .arg(job_id)
      .arg(job_name)
      .arg(&data_json)
      .arg(&opts_json)
      .arg(now_ms)
      .arg(&job_json)
      .arg(run_at)
      .invoke_async(&mut conn)
      .await?;

    if outcome < 0 {
      return Err(QueueError::IdempotencyConflict {
        queue: queue.to_string(),
        id: job_id.to_string(),
      });
    }
    Ok((job_id.to_string(), outcome > 0))
  }

  /// Add a job to the queue with minimal parameters.
  ///
  /// This is a simplified interface for programmatic job creation (e.g. from
  /// the admin API). For full control over job options, use [`enqueue`].
  ///
  /// Returns the assigned job ID as a string.
  #[instrument(skip(self, data))]
  pub async fn add_job(
    &self,
    queue_name: &str,
    job_name: &str,
    data: serde_json::Value,
    delay_ms: Option<i64>,
  ) -> QueueResult<String> {
    let mut conn = self.connection().await?;
    let id_key = self.key(queue_name, "id");

    // Step 1: Atomically increment job ID counter.
    let id: i64 = conn.incr(&id_key, 1i64).await?;
    let job_id = id.to_string();
    let now_ms = Utc::now().timestamp_millis();

    let delay = delay_ms.unwrap_or(0);
    let opts = serde_json::json!({
      "delay": delay,
      "attempts": 1,
    });
    let data_json = serde_json::to_string(&data).map_err(|e| QueueError::Serialization(e.to_string()))?;
    let opts_json = serde_json::to_string(&opts).map_err(|e| QueueError::Serialization(e.to_string()))?;

    let job_hash_key = self.job_key(queue_name, &job_id);

    // Step 2: HSET job hash + push to wait or delayed in one atomic pipeline.
    let mut pipe = redis::pipe();
    pipe
      .atomic()
      .cmd("HSET")
      .arg(&job_hash_key)
      .arg("name")
      .arg(job_name)
      .arg("data")
      .arg(&data_json)
      .arg("opts")
      .arg(&opts_json)
      .arg("timestamp")
      .arg(now_ms)
      .arg("delay")
      .arg(delay)
      .arg("attemptsMade")
      .arg(0i32)
      .ignore();

    // Step 3/4: Route to delayed set or wait list.
    if delay > 0 {
      let delayed_key = self.key(queue_name, "delayed");
      let run_at = now_ms + delay;
      pipe.zadd(&delayed_key, &job_id, run_at as f64).ignore();
      debug!(
        queue = queue_name,
        job_id, job_name, delay, run_at, "add_job: enqueued to delayed set"
      );
    } else {
      let wait_key = self.key(queue_name, "wait");
      pipe.rpush(&wait_key, &job_id).ignore();
      debug!(queue = queue_name, job_id, job_name, "add_job: enqueued to wait list");
    }

    pipe.query_async::<redis::Value>(&mut conn).await?;

    info!(queue = queue_name, job_id, job_name, "job added");
    Ok(job_id)
  }

  /// Dequeue a job from the wait list, moving it to the active list.
  ///
  /// WRK-RV-04b: Uses an atomic Lua script that pops from wait->active, loads
  /// the job hash, and rolls back if the hash is missing. This prevents job
  /// IDs from getting stuck in the `active` list when their hash data is
  /// unreadable or absent.
  ///
  /// Polls with 100ms intervals up to `timeout_seconds`. Returns `None` if
  /// no job is available within the timeout.
  #[instrument(skip(self))]
  pub async fn dequeue(&self, queue: &str, timeout_seconds: u64) -> QueueResult<Option<Job>> {
    let mut conn = self.connection().await?;
    let wait_key = self.key(queue, "wait");
    let active_key = self.key(queue, "active");
    let meta_key = self.key(queue, "meta");
    let job_key_prefix = format!("{}:{}:", self.prefix, queue);
    let now_ms = Utc::now().timestamp_millis();

    // Lua script: atomically pop from wait->active, load hash, roll back on
    // missing data.
    //
    // KEYS[1] = wait list
    // KEYS[2] = active list
    // KEYS[3] = queue metadata
    // ARGV[1] = job key prefix (e.g. "bull:queue:")
    // ARGV[2] = heartbeat timestamp (ms)
    //
    // Returns:
    //   nil          -- queue paused or wait list empty (nothing to pop)
    //   false        -- popped but hash missing, ID removed from active (discarded)
    //   {id, fields} -- job ID + HGETALL result as flat array
    let lua_script = redis::Script::new(
      r#"
if redis.call('HGET', KEYS[3], 'paused') == '1' then
  return nil
end
local job_id = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
if not job_id then
  return nil
end
local job_key = ARGV[1] .. job_id
local fields = redis.call('HGETALL', job_key)
if #fields == 0 then
  redis.call('LREM', KEYS[2], 1, job_id)
  return false
end
redis.call('HSET', job_key, 'heartbeat', ARGV[2])
return {job_id, fields}
"#,
    );

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_seconds);
    let poll_interval = std::time::Duration::from_millis(100);

    loop {
      let result: redis::Value = lua_script
        .key(&wait_key)
        .key(&active_key)
        .key(&meta_key)
        .arg(&job_key_prefix)
        .arg(now_ms)
        .invoke_async(&mut conn)
        .await?;

      match result {
        redis::Value::Nil => {
          // Wait list empty -- poll until timeout.
          if std::time::Instant::now() >= deadline {
            trace!(queue, "dequeue timeout, no jobs available");
            return Ok(None);
          }
          tokio::time::sleep(poll_interval).await;
          continue;
        }
        redis::Value::Boolean(false) => {
          // Popped an ID but hash was missing -- discarded. Try again.
          warn!(queue, "dequeue: popped job with missing hash, discarded from active");
          continue;
        }
        redis::Value::Array(ref arr) if arr.len() == 2 => {
          let job_id = match &arr[0] {
            redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).to_string(),
            redis::Value::SimpleString(s) => s.clone(),
            other => {
              warn!(queue, ?other, "dequeue: unexpected job_id type from Lua");
              continue;
            }
          };

          let fields = match &arr[1] {
            redis::Value::Array(f) => f,
            other => {
              warn!(queue, ?other, "dequeue: unexpected fields type from Lua");
              continue;
            }
          };

          // Parse HGETALL flat array into a Job.
          match self.parse_job_from_hgetall(queue, &job_id, fields) {
            Ok(job) => {
              debug!(queue, job_id, "job dequeued to active list");
              return Ok(Some(job));
            }
            Err(e) => {
              // Parsing failed -- remove from active to prevent stuck entry.
              warn!(queue, job_id, error = %e, "dequeue: failed to parse job hash, removing from active");
              let _: () = redis::pipe()
                .atomic()
                .lrem(&active_key, 1, &job_id)
                .ignore()
                .query_async(&mut conn)
                .await?;
              return Err(e);
            }
          }
        }
        other => {
          warn!(queue, ?other, "dequeue: unexpected Lua return value");
          return Ok(None);
        }
      }
    }
  }

  /// Parse a job from HGETALL flat field/value pairs returned by Lua.
  fn parse_job_from_hgetall(&self, queue: &str, job_id: &str, fields: &[redis::Value]) -> QueueResult<Job> {
    use std::collections::HashMap;

    let mut map = HashMap::new();
    for pair in fields.chunks(2) {
      if let (Some(redis::Value::BulkString(k)), Some(redis::Value::BulkString(v))) = (pair.first(), pair.get(1)) {
        let key = String::from_utf8_lossy(k).to_string();
        let val = String::from_utf8_lossy(v).to_string();
        map.insert(key, val);
      }
    }

    // Try _json first (fast path -- same as read_job).
    if let Some(json_data) = map.get("_json") {
      let mut job: Job = serde_json::from_str(json_data).map_err(|e| QueueError::Serialization(e.to_string()))?;
      if let Some(a) = map.get("attemptsMade").and_then(|v| v.parse::<i32>().ok()) {
        job.attempts_made = a;
      }
      job.heartbeat = map.get("heartbeat").and_then(|v| v.parse::<i64>().ok());
      job.failed_reason = map.get("failedReason").cloned();
      job.finished_on = map.get("finishedOn").and_then(|v| v.parse::<i64>().ok());
      return Ok(job);
    }

    // Fallback: reconstruct from individual fields.
    let name = map.get("name").cloned().ok_or_else(|| QueueError::NotFound {
      queue: queue.to_string(),
      id: job_id.to_string(),
    })?;
    let data_str = map.get("data").map(|s| s.as_str()).unwrap_or("{}");
    let opts_str = map.get("opts").map(|s| s.as_str()).unwrap_or("{}");
    let timestamp = map.get("timestamp").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let attempts_made = map.get("attemptsMade").and_then(|v| v.parse::<i32>().ok()).unwrap_or(0);

    let data = serde_json::from_str(data_str).unwrap_or(serde_json::Value::Object(Default::default()));
    let opts = serde_json::from_str(opts_str).unwrap_or_default();

    Ok(Job {
      id: job_id.to_string(),
      name,
      data,
      opts,
      timestamp,
      attempts_made,
      finished_on: map.get("finishedOn").and_then(|v| v.parse::<i64>().ok()),
      failed_reason: map.get("failedReason").cloned(),
      heartbeat: map.get("heartbeat").and_then(|v| v.parse::<i64>().ok()),
      return_value: None,
    })
  }

  /// Acknowledge a job as successfully completed.
  ///
  /// Removes the successful job immediately by default. When
  /// `removeOnComplete` is disabled, moves it to the completed set instead.
  #[instrument(skip(self, return_value))]
  pub async fn ack(
    &self,
    queue: &str,
    job_id: &str,
    return_value: Option<serde_json::Value>,
    retention: TerminalRetentionPolicy,
  ) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let active_key = self.key(queue, "active");
    let completed_key = self.key(queue, "completed");
    let job_hash_key = self.job_key(queue, job_id);
    let now_ms = Utc::now().timestamp_millis();

    let mut pipe = redis::pipe();
    pipe
      .atomic()
      .cmd("LREM")
      .arg(&active_key)
      .arg(1i32)
      .arg(job_id)
      .ignore();

    if retention.remove_on_complete {
      pipe
        .cmd("SREM")
        .arg(&completed_key)
        .arg(job_id)
        .ignore()
        .cmd("UNLINK")
        .arg(&job_hash_key)
        .ignore();
    } else {
      pipe
        .cmd("SADD")
        .arg(&completed_key)
        .arg(job_id)
        .ignore()
        .cmd("HSET")
        .arg(&job_hash_key)
        .arg("finishedOn")
        .arg(now_ms)
        .ignore();

      if let Some(rv) = &return_value {
        let rv_json = serde_json::to_string(rv).map_err(|e| QueueError::Serialization(e.to_string()))?;
        pipe
          .cmd("HSET")
          .arg(&job_hash_key)
          .arg("returnvalue")
          .arg(&rv_json)
          .ignore();
      }
    }

    pipe.query_async::<redis::Value>(&mut conn).await?;
    debug!(queue, job_id, "job acknowledged as completed");
    Ok(())
  }

  /// Record a job failure. If `retry_at` is provided, the job is moved to the
  /// delayed set for retry; otherwise it is moved to the failed set permanently.
  #[instrument(skip(self))]
  pub async fn fail(
    &self,
    queue: &str,
    job_id: &str,
    error: &str,
    retry_at: Option<i64>,
    retention: TerminalRetentionPolicy,
  ) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let active_key = self.key(queue, "active");
    let job_hash_key = self.job_key(queue, job_id);

    let mut pipe = redis::pipe();
    pipe
      .atomic()
      .cmd("LREM")
      .arg(&active_key)
      .arg(1i32)
      .arg(job_id)
      .ignore()
      .cmd("HINCRBY")
      .arg(&job_hash_key)
      .arg("attemptsMade")
      .arg(1i32)
      .ignore()
      .cmd("HSET")
      .arg(&job_hash_key)
      .arg("failedReason")
      .arg(error)
      .ignore();

    if let Some(retry_at_ms) = retry_at {
      let delayed_key = self.key(queue, "delayed");
      pipe
        .cmd("ZADD")
        .arg(&delayed_key)
        .arg(retry_at_ms as f64)
        .arg(job_id)
        .ignore();
      debug!(queue, job_id, retry_at_ms, "job failed, scheduled for retry");
    } else {
      let failed_key = self.key(queue, "failed");
      let retention_key = self.terminal_retention_key(queue, "failed");
      let now_ms = Utc::now().timestamp_millis();
      pipe
        .cmd("SADD")
        .arg(&failed_key)
        .arg(job_id)
        .ignore()
        .cmd("HSET")
        .arg(&job_hash_key)
        .arg("finishedOn")
        .arg(now_ms)
        .ignore()
        .cmd("ZADD")
        .arg(&retention_key)
        .arg(now_ms)
        .arg(job_id)
        .ignore();
      debug!(queue, job_id, "job failed permanently");
    }

    pipe.query_async::<redis::Value>(&mut conn).await?;
    if retry_at.is_none()
      && let Err(error) = self.prune_failed_jobs(queue, retention).await
    {
      warn!(queue, job_id, %error, "terminal queue pruning failed after permanent failure (non-fatal)");
    }
    Ok(())
  }

  /// Update the heartbeat timestamp for an active job.
  #[instrument(skip(self))]
  pub async fn heartbeat(&self, queue: &str, job_id: &str) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let job_hash_key = self.job_key(queue, job_id);
    let now_ms = Utc::now().timestamp_millis();
    conn.hset::<_, _, _, ()>(&job_hash_key, "heartbeat", now_ms).await?;
    trace!(queue, job_id, "heartbeat updated");
    Ok(())
  }

  /// Find jobs in the active list that have not sent a heartbeat within
  /// `stall_interval_ms` milliseconds.
  #[instrument(skip(self))]
  pub async fn check_stalled(&self, queue: &str, stall_interval_ms: i64) -> QueueResult<Vec<String>> {
    let mut conn = self.connection().await?;
    let active_key = self.key(queue, "active");
    let now_ms = Utc::now().timestamp_millis();
    let stall_threshold = now_ms - stall_interval_ms;

    let active_ids: Vec<String> = conn.lrange(&active_key, 0, -1).await?;
    let mut stalled = Vec::new();

    for job_id in &active_ids {
      let job_hash_key = self.job_key(queue, job_id);
      let heartbeat: Option<i64> = conn.hget(&job_hash_key, "heartbeat").await?;
      match heartbeat {
        Some(hb) if hb < stall_threshold => {
          stalled.push(job_id.clone());
        }
        None => {
          // No heartbeat set — check timestamp instead
          let timestamp: Option<i64> = conn.hget(&job_hash_key, "timestamp").await?;
          if timestamp.unwrap_or(0) < stall_threshold {
            stalled.push(job_id.clone());
          }
        }
        _ => {}
      }
    }

    if !stalled.is_empty() {
      warn!(queue, stalled_count = stalled.len(), "stalled jobs detected");
    }
    Ok(stalled)
  }

  /// Move a stalled job from active back to the wait list or to the failed set.
  ///
  /// QUEUE-ROB-01: Uses a single atomic Lua script to prevent the job from
  /// getting stuck in an intermediate state if the connection dies between
  /// pipeline calls. The script: LREM active → check attempts → either
  /// SADD failed (permanent) or LPUSH wait (retry) → HSET metadata.
  #[instrument(skip(self))]
  pub async fn recover_stalled_job(
    &self,
    queue: &str,
    job_id: &str,
    retention: TerminalRetentionPolicy,
  ) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let active_key = self.key(queue, "active");
    let wait_key = self.key(queue, "wait");
    let failed_key = self.key(queue, "failed");
    let failed_retention_key = self.terminal_retention_key(queue, "failed");
    let job_hash_key = self.job_key(queue, job_id);

    // Check attempts before running the atomic script
    let attempts_made: i32 = conn.hget(&job_hash_key, "attemptsMade").await.unwrap_or(0);
    let opts_str: String = conn
      .hget(&job_hash_key, "opts")
      .await
      .unwrap_or_else(|_| "{}".to_string());
    let opts: JobOptions = serde_json::from_str(&opts_str).unwrap_or_default();

    let now_ms = Utc::now().timestamp_millis();
    let should_fail = attempts_made + 1 >= opts.max_attempts;

    // Single atomic Lua script: LREM active → SADD failed or LPUSH wait → HSET metadata
    let lua_script = r#"
      -- Remove from active list
      redis.call('LREM', KEYS[1], 1, ARGV[1])

      if ARGV[2] == '1' then
        -- Permanently fail
        redis.call('SADD', KEYS[3], ARGV[1])
        redis.call('ZADD', KEYS[5], ARGV[3], ARGV[1])
        redis.call('HSET', KEYS[4],
          'failedReason', 'stalled: worker died mid-processing',
          'finishedOn', ARGV[3],
          'attemptsMade', ARGV[4])
      else
        -- Re-queue for retry
        redis.call('LPUSH', KEYS[2], ARGV[1])
        redis.call('HINCRBY', KEYS[4], 'attemptsMade', 1)
        redis.call('HSET', KEYS[4],
          'failedReason', 'stalled: re-queued for retry')
      end
      return 1
    "#;

    redis::cmd("EVAL")
      .arg(lua_script)
      .arg(5) // KEYS count
      .arg(&active_key) // KEYS[1]
      .arg(&wait_key) // KEYS[2]
      .arg(&failed_key) // KEYS[3]
      .arg(&job_hash_key) // KEYS[4]
      .arg(&failed_retention_key) // KEYS[5]
      .arg(job_id) // ARGV[1]
      .arg(if should_fail { "1" } else { "0" }) // ARGV[2]
      .arg(now_ms) // ARGV[3]
      .arg(attempts_made + 1) // ARGV[4]
      .query_async::<redis::Value>(&mut conn)
      .await?;

    if should_fail {
      if let Err(error) = self.prune_failed_jobs(queue, retention).await {
        warn!(queue, job_id, %error, "terminal queue pruning failed after stalled-job failure (non-fatal)");
      }
      warn!(queue, job_id, "stalled job permanently failed (max attempts reached)");
    } else {
      debug!(queue, job_id, "stalled job re-queued for retry");
    }

    Ok(())
  }

  /// Return a snapshot of queue statistics.
  ///
  /// WRK-RV-03b: Partial failure mode — when some stats succeed and others fail,
  /// returns the successful values with failed ones set to 0 and `degraded: true`.
  /// Only returns a hard error if ALL stat queries fail (or the connection itself
  /// cannot be established).
  #[instrument(skip(self))]
  pub async fn queue_stats(&self, queue: &str) -> QueueResult<QueueStats> {
    let mut conn = self.connection().await?;

    let mut degraded = false;
    let mut failures = 0u32;
    const STAT_COUNT: u32 = 6;

    let waiting: i64 = match conn.llen(self.key(queue, "wait")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read waiting count");
        degraded = true;
        failures += 1;
        0
      }
    };
    let active: i64 = match conn.llen(self.key(queue, "active")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read active count");
        degraded = true;
        failures += 1;
        0
      }
    };
    let completed: i64 = match conn.scard(self.key(queue, "completed")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read completed count");
        degraded = true;
        failures += 1;
        0
      }
    };
    let failed: i64 = match conn.scard(self.key(queue, "failed")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read failed count");
        degraded = true;
        failures += 1;
        0
      }
    };
    let delayed: i64 = match conn.zcard(self.key(queue, "delayed")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read delayed count");
        degraded = true;
        failures += 1;
        0
      }
    };
    let stalled: i64 = match conn.scard(self.key(queue, "stalled")).await {
      Ok(v) => v,
      Err(e) => {
        warn!(queue, error = %e, "queue_stats: failed to read stalled count");
        degraded = true;
        failures += 1;
        0
      }
    };

    // If ALL stats failed, propagate as a hard error — the connection is likely dead.
    if failures == STAT_COUNT {
      return Err(QueueError::Redis(redis::RedisError::from((
        redis::ErrorKind::Io,
        "all queue stat queries failed — Redis connection likely dead",
      ))));
    }

    Ok(QueueStats {
      queue: queue.to_string(),
      waiting,
      active,
      completed,
      failed,
      delayed,
      stalled,
      degraded,
    })
  }

  /// List job IDs and their hash data for a given status.
  ///
  /// `status` must be one of: `"waiting"`, `"active"`, `"completed"`, `"failed"`,
  /// `"delayed"`. Returns `(jobs, total_count)` where `jobs` is at most `limit`
  /// entries starting at `cursor`.
  ///
  /// Each returned job is a `serde_json::Value` object with fields from the
  /// Redis hash (name, data, opts, timestamp, attemptsMade, etc.) plus an `id`
  /// field.  Jobs whose hash is missing or unreadable are silently skipped.
  #[instrument(skip(self))]
  pub async fn list_jobs(
    &self,
    queue: &str,
    status: &str,
    cursor: i64,
    limit: i64,
  ) -> QueueResult<(Vec<serde_json::Value>, i64)> {
    let mut conn = self.connection().await?;

    // Fetch job IDs from the appropriate Redis structure.
    let (job_ids, total): (Vec<String>, i64) = match status {
      "waiting" => {
        let key = self.key(queue, "wait");
        let total: i64 = conn.llen(&key).await.unwrap_or(0);
        let ids: Vec<String> = if total > 0 {
          conn
            .lrange(&key, cursor as isize, (cursor + limit - 1) as isize)
            .await
            .unwrap_or_default()
        } else {
          vec![]
        };
        (ids, total)
      }
      "active" => {
        let key = self.key(queue, "active");
        let total: i64 = conn.llen(&key).await.unwrap_or(0);
        let ids: Vec<String> = if total > 0 {
          conn
            .lrange(&key, cursor as isize, (cursor + limit - 1) as isize)
            .await
            .unwrap_or_default()
        } else {
          vec![]
        };
        (ids, total)
      }
      "delayed" => {
        let key = self.key(queue, "delayed");
        let total: i64 = conn.zcard(&key).await.unwrap_or(0);
        let ids: Vec<String> = if total > 0 {
          conn
            .zrange(&key, cursor as isize, (cursor + limit - 1) as isize)
            .await
            .unwrap_or_default()
        } else {
          vec![]
        };
        (ids, total)
      }
      "completed" | "failed" => {
        let key = self.key(queue, status);
        let total: i64 = conn.scard(&key).await.unwrap_or(0);
        // QUEUE-ROB-06: Use SSCAN for scalable pagination instead of SMEMBERS.
        // SSCAN iterates in O(1) per call regardless of set size.
        // We skip `cursor` items and collect up to `limit`.
        let mut ids = Vec::with_capacity(limit as usize);
        let mut scan_cursor: u64 = 0;
        let mut skipped: i64 = 0;
        loop {
          let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SSCAN")
            .arg(&key)
            .arg(scan_cursor)
            .arg("COUNT")
            .arg(200) // hint to Redis for batch size
            .query_async(&mut conn)
            .await
            .unwrap_or((0, vec![]));

          for id in batch {
            if skipped < cursor {
              skipped += 1;
              continue;
            }
            if (ids.len() as i64) >= limit {
              break;
            }
            ids.push(id);
          }

          if next_cursor == 0 || (ids.len() as i64) >= limit {
            break;
          }
          scan_cursor = next_cursor;
        }
        (ids, total)
      }
      _ => (vec![], 0),
    };

    // Load each job's hash data.
    let mut jobs = Vec::with_capacity(job_ids.len());
    for id in &job_ids {
      let hash_key = self.job_key(queue, id);
      let fields: Vec<(String, String)> = match conn.hgetall(&hash_key).await {
        Ok(f) => f,
        Err(e) => {
          trace!(queue, id, error = %e, "list_jobs: skipping job with unreadable hash");
          continue;
        }
      };
      if fields.is_empty() {
        continue;
      }
      let mut obj = serde_json::Map::new();
      obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
      for (k, v) in fields {
        // Try to parse as JSON first (for data, opts, _json fields).
        // Non-JSON values (timestamps, numeric strings) are kept as strings.
        let value = serde_json::from_str::<serde_json::Value>(&v).unwrap_or_else(|_| {
          trace!(queue, id, field = %k, "list_jobs: field value is not valid JSON, keeping as string");
          serde_json::Value::String(v)
        });
        obj.insert(k, value);
      }
      jobs.push(serde_json::Value::Object(obj));
    }

    Ok((jobs, total))
  }

  // ── Queue Management Operations (BF-SRV-04) ─────────────────────────

  /// Pause a queue by setting a `paused` flag in the queue meta hash.
  /// Paused queues are not dequeued by workers.
  #[instrument(skip(self))]
  pub async fn pause_queue(&self, queue: &str) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let meta_key = self.key(queue, "meta");
    let _: () = conn.hset(&meta_key, "paused", "1").await?;
    info!(queue, "queue paused");
    Ok(())
  }

  /// Resume a paused queue.
  #[instrument(skip(self))]
  pub async fn resume_queue(&self, queue: &str) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let meta_key = self.key(queue, "meta");
    let _: () = conn.hset(&meta_key, "paused", "0").await?;
    info!(queue, "queue resumed");
    Ok(())
  }

  /// Check if a queue is paused.
  pub async fn is_paused(&self, queue: &str) -> QueueResult<bool> {
    let mut conn = self.connection().await?;
    let meta_key = self.key(queue, "meta");
    let paused: Option<String> = conn.hget(&meta_key, "paused").await?;
    Ok(paused.as_deref() == Some("1"))
  }

  /// Retry a failed job: move from failed set to wait list, reset attempts.
  #[instrument(skip(self))]
  pub async fn retry_job(&self, queue: &str, job_id: &str) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let failed_key = self.key(queue, "failed");
    let wait_key = self.key(queue, "wait");
    let job_hash_key = self.job_key(queue, job_id);

    // Atomic: SREM failed + LPUSH wait + reset metadata
    let lua = r#"
      local removed = redis.call('SREM', KEYS[1], ARGV[1])
      if removed == 0 then return 0 end
      redis.call('LPUSH', KEYS[2], ARGV[1])
      redis.call('HSET', KEYS[3], 'attemptsMade', 0, 'failedReason', '', 'finishedOn', '')
      return 1
    "#;
    let result: i32 = redis::cmd("EVAL")
      .arg(lua)
      .arg(3)
      .arg(&failed_key)
      .arg(&wait_key)
      .arg(&job_hash_key)
      .arg(job_id)
      .query_async(&mut conn)
      .await?;

    if result == 0 {
      warn!(queue, job_id, "retry_job: job not found in failed set");
    } else {
      info!(queue, job_id, "job retried: moved from failed to wait");
    }
    Ok(())
  }

  /// Promote a delayed job: move from delayed set to wait list.
  #[instrument(skip(self))]
  pub async fn promote_job(&self, queue: &str, job_id: &str) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    let delayed_key = self.key(queue, "delayed");
    let wait_key = self.key(queue, "wait");

    let lua = r#"
      local removed = redis.call('ZREM', KEYS[1], ARGV[1])
      if removed == 0 then return 0 end
      redis.call('LPUSH', KEYS[2], ARGV[1])
      return 1
    "#;
    let result: i32 = redis::cmd("EVAL")
      .arg(lua)
      .arg(2)
      .arg(&delayed_key)
      .arg(&wait_key)
      .arg(job_id)
      .query_async(&mut conn)
      .await?;

    if result == 0 {
      warn!(queue, job_id, "promote_job: job not found in delayed set");
    } else {
      info!(queue, job_id, "job promoted: moved from delayed to wait");
    }
    Ok(())
  }

  /// Get a single job by ID.
  #[instrument(skip(self))]
  pub async fn get_job(&self, queue: &str, job_id: &str) -> QueueResult<Option<Job>> {
    let mut conn = self.connection().await?;
    let job_hash_key = self.job_key(queue, job_id);

    let fields: Vec<(String, String)> = conn.hgetall(&job_hash_key).await?;
    if fields.is_empty() {
      return Ok(None);
    }

    let map: std::collections::HashMap<String, String> = fields.into_iter().collect();
    if let Some(json_str) = map.get("_json") {
      match serde_json::from_str::<Job>(json_str) {
        Ok(mut job) => {
          // Merge live fields that may have been updated outside _json
          if let Some(a) = map.get("attemptsMade").and_then(|s| s.parse().ok()) {
            job.attempts_made = a;
          }
          if let Some(f) = map.get("finishedOn").and_then(|s| s.parse().ok()) {
            job.finished_on = Some(f);
          }
          if let Some(r) = map.get("failedReason") {
            job.failed_reason = Some(r.clone());
          }
          if let Some(value) = map.get("returnvalue") {
            job.return_value =
              Some(serde_json::from_str(value).map_err(|error| QueueError::Serialization(error.to_string()))?);
          }
          return Ok(Some(job));
        }
        Err(e) => {
          warn!(queue, job_id, error = %e, "get_job: _json parse failed");
        }
      }
    }

    // Fallback: reconstruct from individual fields
    let data_str = map.get("data").map(|s| s.as_str()).unwrap_or("{}");
    let data = serde_json::from_str(data_str).unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
    let opts_str = map.get("opts").map(|s| s.as_str()).unwrap_or("{}");
    let opts = serde_json::from_str(opts_str).unwrap_or_default();

    Ok(Some(Job {
      id: job_id.to_string(),
      name: map.get("name").cloned().unwrap_or_default(),
      data,
      opts,
      timestamp: map.get("timestamp").and_then(|s| s.parse().ok()).unwrap_or(0),
      attempts_made: map.get("attemptsMade").and_then(|s| s.parse().ok()).unwrap_or(0),
      finished_on: map.get("finishedOn").and_then(|s| s.parse().ok()),
      failed_reason: map.get("failedReason").cloned(),
      heartbeat: map.get("heartbeat").and_then(|s| s.parse().ok()),
      return_value: map.get("returnvalue").and_then(|s| serde_json::from_str(s).ok()),
    }))
  }

  /// Clean completed or failed jobs older than `grace_ms` milliseconds.
  /// Returns the number of jobs removed.
  #[instrument(skip(self))]
  pub async fn clean_queue(&self, queue: &str, status: &str, grace_ms: i64) -> QueueResult<usize> {
    let mut conn = self.connection().await?;
    let set_key = self.key(queue, status);
    let retention_key = self.terminal_retention_key(queue, status);
    let threshold = Utc::now().timestamp_millis() - grace_ms;

    // Get all job IDs from the set
    let job_ids: Vec<String> = conn.smembers(&set_key).await?;
    let mut removed = 0usize;

    for job_id in &job_ids {
      let job_hash_key = self.job_key(queue, job_id);
      let finished_on: Option<i64> = conn.hget(&job_hash_key, "finishedOn").await.unwrap_or(None);

      if let Some(ts) = finished_on
        && ts < threshold
      {
        // Remove from set and delete hash
        let mut pipe = redis::pipe();
        pipe
          .atomic()
          .cmd("SREM")
          .arg(&set_key)
          .arg(job_id)
          .ignore()
          .cmd("DEL")
          .arg(&job_hash_key)
          .ignore()
          .cmd("ZREM")
          .arg(&retention_key)
          .arg(job_id)
          .ignore();
        pipe.query_async::<redis::Value>(&mut conn).await?;
        removed += 1;
      }
    }

    info!(queue, status, removed, grace_ms, "queue cleaned");
    Ok(removed)
  }

  /// Remove failed job history beyond the configured retention policy.
  ///
  /// The status sets remain Bull-compatible while a small sorted-set index
  /// provides efficient age and count pruning. State membership, retention
  /// index entries and job hashes are removed atomically in bounded batches.
  #[instrument(skip(self))]
  pub async fn prune_failed_jobs(&self, queue: &str, retention: TerminalRetentionPolicy) -> QueueResult<usize> {
    let now_ms = Utc::now().timestamp_millis();
    let retention_ms = retention.failed_age_seconds.saturating_mul(1_000);
    let retention_ms = i64::try_from(retention_ms).unwrap_or(i64::MAX);
    let mut removed = 0usize;

    loop {
      let count = self
        .prune_failed_jobs_with_policy(
          queue,
          now_ms.saturating_sub(retention_ms),
          retention.failed_max_count as i64,
          TERMINAL_RETENTION_PRUNE_BATCH,
        )
        .await?;
      removed += count;
      if count < TERMINAL_RETENTION_PRUNE_BATCH as usize {
        break;
      }
    }

    if removed > 0 {
      info!(queue, removed, "failed queue history pruned");
    }
    Ok(removed)
  }

  async fn prune_failed_jobs_with_policy(
    &self,
    queue: &str,
    cutoff_ms: i64,
    max_count: i64,
    batch_size: i64,
  ) -> QueueResult<usize> {
    let mut conn = self.connection().await?;
    let status_key = self.key(queue, "failed");
    let retention_key = self.terminal_retention_key(queue, "failed");
    let job_key_prefix = format!("{}:{}:", self.prefix, queue);

    let lua_script = r#"
      local removed = {}
      local seen = {}

      local function remember(ids)
        for _, id in ipairs(ids) do
          if not seen[id] then
            seen[id] = true
            table.insert(removed, id)
          end
        end
      end

      remember(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1],
        'LIMIT', 0, ARGV[3]))

      local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[2])
      if excess > 0 then
        local overflow_count = math.min(excess, tonumber(ARGV[3]))
        remember(redis.call('ZRANGE', KEYS[2], 0, overflow_count - 1))
      end

      for _, id in ipairs(removed) do
        redis.call('SREM', KEYS[1], id)
        redis.call('ZREM', KEYS[2], id)
        redis.call('UNLINK', ARGV[4] .. id)
      end

      return #removed
    "#;

    let removed: i64 = redis::cmd("EVAL")
      .arg(lua_script)
      .arg(2)
      .arg(status_key)
      .arg(retention_key)
      .arg(cutoff_ms)
      .arg(max_count)
      .arg(batch_size)
      .arg(job_key_prefix)
      .query_async(&mut conn)
      .await?;

    Ok(removed.max(0) as usize)
  }

  /// Empty a queue: remove all waiting and delayed jobs.
  #[instrument(skip(self))]
  pub async fn empty_queue(&self, queue: &str) -> QueueResult<usize> {
    let mut conn = self.connection().await?;
    let wait_key = self.key(queue, "wait");
    let delayed_key = self.key(queue, "delayed");

    let wait_count: i64 = conn.llen(&wait_key).await.unwrap_or(0);
    let delayed_count: i64 = conn.zcard(&delayed_key).await.unwrap_or(0);

    // Get all job IDs before deleting the lists
    let wait_ids: Vec<String> = conn.lrange(&wait_key, 0, -1).await.unwrap_or_default();
    let delayed_ids: Vec<String> = conn.zrange(&delayed_key, 0isize, -1isize).await.unwrap_or_default();

    // Delete lists/sets
    let _: () = conn.del(&wait_key).await?;
    let _: () = conn.del(&delayed_key).await?;

    // Delete job hashes
    for id in wait_ids.iter().chain(delayed_ids.iter()) {
      let _: () = conn.del(self.job_key(queue, id)).await.unwrap_or(());
    }

    let total = (wait_count + delayed_count) as usize;
    info!(queue, waiting = wait_count, delayed = delayed_count, "queue emptied");
    Ok(total)
  }

  /// Promote delayed jobs whose score (run-at timestamp) is <= now to the wait list.
  ///
  /// Returns the number of promoted jobs.
  #[instrument(skip(self))]
  pub async fn promote_delayed(&self, queue: &str) -> QueueResult<usize> {
    let mut conn = self.connection().await?;
    let delayed_key = self.key(queue, "delayed");
    let wait_key = self.key(queue, "wait");
    let now_ms = Utc::now().timestamp_millis() as f64;

    // Get all jobs with score <= now
    let due_jobs: Vec<String> = conn.zrangebyscore(&delayed_key, 0f64, now_ms).await?;

    if due_jobs.is_empty() {
      return Ok(0);
    }

    let count = due_jobs.len();
    for job_id in &due_jobs {
      redis::pipe()
        .atomic()
        .cmd("ZREM")
        .arg(&delayed_key)
        .arg(job_id)
        .ignore()
        .cmd("LPUSH")
        .arg(&wait_key)
        .arg(job_id)
        .ignore()
        .query_async::<redis::Value>(&mut conn)
        .await?;
    }

    debug!(queue, count, "promoted delayed jobs to wait list");
    Ok(count)
  }

  /// Reconcile orphaned jobs at startup (WRK-RV-02b).
  ///
  /// Scans for job hash keys that exist in Redis but are NOT referenced by any
  /// queue list/set (wait, active, delayed, completed, failed, stalled).
  /// These are "orphaned" — they have metadata but no queue entry, typically
  /// caused by a crash between the HSET and LPUSH/ZADD (pre-WRK-RV-02a) or
  /// a Redis transaction failure.
  ///
  /// Orphaned jobs are deleted (their hash is removed) because there is no
  /// reliable way to determine their intended state. Since WRK-RV-02a made
  /// enqueue atomic, new orphans should be extremely rare.
  ///
  /// Returns the number of orphaned jobs cleaned up.
  #[instrument(skip(self))]
  pub async fn reconcile_orphaned_jobs(&self, queue: &str) -> QueueResult<usize> {
    let mut conn = self.connection().await?;

    // Collect all known job IDs from every queue state list/set.
    let wait_ids: Vec<String> = conn.lrange(self.key(queue, "wait"), 0, -1).await?;
    let active_ids: Vec<String> = conn.lrange(self.key(queue, "active"), 0, -1).await?;
    let completed_ids: Vec<String> = conn.smembers(self.key(queue, "completed")).await?;
    let failed_ids: Vec<String> = conn.smembers(self.key(queue, "failed")).await?;
    let delayed_ids: Vec<String> = conn.zrangebyscore(self.key(queue, "delayed"), "-inf", "+inf").await?;
    let stalled_ids: Vec<String> = conn.smembers(self.key(queue, "stalled")).await?;

    let mut known_ids = std::collections::HashSet::new();
    for id in wait_ids
      .iter()
      .chain(active_ids.iter())
      .chain(completed_ids.iter())
      .chain(failed_ids.iter())
      .chain(delayed_ids.iter())
      .chain(stalled_ids.iter())
    {
      known_ids.insert(id.as_str());
    }

    // Well-known suffixes that are NOT job hashes.
    let reserved_suffixes: std::collections::HashSet<&str> = [
      "wait",
      "active",
      "completed",
      "failed",
      "failed-retention",
      "delayed",
      "stalled",
      "id",
      "meta",
    ]
    .iter()
    .copied()
    .collect();

    // SCAN for all keys matching <prefix>:<queue>:*
    let pattern = format!("{}:{}:*", self.prefix, queue);
    let mut cursor: u64 = 0;
    let mut orphaned_keys = Vec::new();

    loop {
      let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&pattern)
        .arg("COUNT")
        .arg(200)
        .query_async(&mut conn)
        .await?;

      let key_prefix = format!("{}:{}:", self.prefix, queue);
      for key in &keys {
        if let Some(suffix) = key.strip_prefix(&key_prefix) {
          // Skip reserved keys (wait, active, id, meta, etc.)
          if reserved_suffixes.contains(suffix) {
            continue;
          }
          // Check if this looks like a numeric job ID
          if suffix.parse::<i64>().is_ok() && !known_ids.contains(suffix) {
            orphaned_keys.push(key.clone());
          }
        }
      }

      cursor = next_cursor;
      if cursor == 0 {
        break;
      }
    }

    let count = orphaned_keys.len();
    if count > 0 {
      // Delete orphaned job hashes in batches
      for chunk in orphaned_keys.chunks(100) {
        let _: () = redis::cmd("DEL").arg(chunk).query_async(&mut conn).await?;
      }
      warn!(queue, count, "cleaned up orphaned job hashes (WRK-RV-02b)");
    } else {
      debug!(queue, "no orphaned jobs found");
    }

    Ok(count)
  }

  /// Send a PING to verify Redis connectivity.
  pub async fn ping(&self) -> QueueResult<()> {
    let mut conn = self.connection().await?;
    redis::cmd("PING").query_async::<String>(&mut conn).await?;
    Ok(())
  }
}

impl std::fmt::Debug for RedisQueue {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("RedisQueue").field("prefix", &self.prefix).finish()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use redis::AsyncCommands;
  use uuid::Uuid;

  /// Return the Redis URL to use for tests.
  fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
  }

  /// Create a fresh `RedisQueue` with a unique per-test prefix so tests are
  /// fully isolated from one another.
  async fn test_queue() -> RedisQueue {
    let prefix = format!("test-{}", Uuid::new_v4().as_simple());
    RedisQueue::new(&redis_url(), prefix).expect("RedisQueue::new")
  }

  #[tokio::test]
  async fn history_is_bounded_deduplicated_and_preserves_gaps() {
    let queue = test_queue().await;
    let mut stats = QueueStats {
      queue: "history-test".into(),
      waiting: 2,
      active: 3,
      delayed: 4,
      completed: 100,
      failed: 200,
      stalled: 0,
      degraded: false,
    };
    let now = 172_800_000;
    queue
      .record_history(&stats, now - 86_460_000)
      .await
      .expect("old sample");
    queue
      .record_history(&stats, now - 86_400_000)
      .await
      .expect("boundary sample");
    queue
      .record_history(&stats, now - 120_000)
      .await
      .expect("sample before gap");
    stats.degraded = true;
    queue
      .record_history(&stats, now - 60_000)
      .await
      .expect("skip degraded sample");
    stats.degraded = false;
    queue.record_history(&stats, now).await.expect("latest sample");
    stats.waiting = 0;
    stats.active = 0;
    stats.delayed = 0;
    queue
      .clone()
      .record_history(&stats, now + 999)
      .await
      .expect("replace minute");
    assert_eq!(
      queue.history(&stats.queue, now + 999).await.expect("read history"),
      vec![
        QueueHistoryPoint {
          timestamp: now - 120_000,
          pending: 9
        },
        QueueHistoryPoint {
          timestamp: now,
          pending: 0
        },
      ]
    );
    let mut conn = queue.connection().await.expect("cleanup connection");
    let key = queue.key(&stats.queue, "history");
    let count: i64 = conn.zcard(&key).await.expect("bounded members");
    assert_eq!(count, 3);
    let ttl: i64 = conn.ttl(&key).await.expect("history expiry");
    assert!((89_990..=90_000).contains(&ttl));
    let _: i64 = conn.del(key).await.expect("remove test-owned history");
  }

  #[tokio::test]
  async fn queue_clones_reuse_one_reconnecting_command_connection() {
    let queue = test_queue().await;
    let clone = queue.clone();
    let mut first = queue.connection().await.expect("first command connection");
    let mut second = clone.connection().await.expect("cloned command connection");

    let first_id: i64 = redis::cmd("CLIENT")
      .arg("ID")
      .query_async(&mut first)
      .await
      .expect("first Redis client id");
    let second_id: i64 = redis::cmd("CLIENT")
      .arg("ID")
      .query_async(&mut second)
      .await
      .expect("second Redis client id");

    assert_eq!(
      first_id, second_id,
      "queue clones must multiplex commands over one role-scoped Redis transport"
    );
  }

  /// Delete all `<prefix>:<queue_name>:*` keys left behind by a test.
  async fn cleanup(q: &RedisQueue, queue_name: &str) {
    let pattern = format!("{}:{}:*", q.prefix, queue_name);
    let mut conn = q.connection().await.expect("conn for cleanup");
    let keys: Vec<String> = redis::cmd("KEYS")
      .arg(&pattern)
      .query_async(&mut conn)
      .await
      .unwrap_or_default();
    // Also delete the bare cron tracking key if present.
    let cron_pattern = format!("cron:{}:*", queue_name);
    let cron_keys: Vec<String> = redis::cmd("KEYS")
      .arg(&cron_pattern)
      .query_async(&mut conn)
      .await
      .unwrap_or_default();
    let all_keys: Vec<String> = keys.into_iter().chain(cron_keys).collect();
    if !all_keys.is_empty() {
      let _: () = redis::cmd("DEL")
        .arg(all_keys)
        .query_async(&mut conn)
        .await
        .unwrap_or(());
    }
  }

  // -----------------------------------------------------------------------
  // Basic enqueue / dequeue
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn enqueue_and_dequeue_returns_job() {
    let q = test_queue().await;
    let qn = "q-basic";

    let opts = JobOptions::default();
    q.enqueue(qn, "test-job", serde_json::json!({"data": 42}), opts)
      .await
      .expect("enqueue");

    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job present");
    assert_eq!(job.name, "test-job");
    assert_eq!(job.data["data"], 42);

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn dequeue_empty_queue_returns_none() {
    let q = test_queue().await;
    let qn = "q-empty";

    // One-second bounded poll window exercises the empty-queue retry path
    // instead of returning after the first zero-window probe.
    let result = q.dequeue(qn, 1).await.expect("dequeue");
    assert!(result.is_none(), "empty queue should return None");

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn paused_queue_keeps_waiting_jobs_until_resumed() {
    let q = test_queue().await;
    let qn = "q-paused";

    q.enqueue(qn, "test-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");
    q.pause_queue(qn).await.expect("pause queue");

    assert!(q.dequeue(qn, 1).await.expect("paused dequeue").is_none());
    let stats = q.queue_stats(qn).await.expect("paused queue stats");
    assert_eq!(stats.waiting, 1, "pause must leave the job on the wait list");
    assert_eq!(stats.active, 0, "pause must not claim the job");

    q.resume_queue(qn).await.expect("resume queue");
    let job = q.dequeue(qn, 1).await.expect("resumed dequeue").expect("waiting job");
    assert_eq!(job.name, "test-job");

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn stable_job_id_is_idempotent_and_recovers_terminal_delivery() {
    let q = test_queue().await;
    let qn = "q-idempotent";
    let job_id = "git-sync-run-1";
    let data = serde_json::json!({"runId": "run-1", "trigger": "Manual"});

    let (_, inserted) = q
      .enqueue_idempotent(qn, job_id, "git-sync.syncRun", data.clone(), JobOptions::default())
      .await
      .expect("first idempotent enqueue");
    assert!(inserted);
    let (_, replay_inserted) = q
      .enqueue_idempotent(qn, job_id, "git-sync.syncRun", data.clone(), JobOptions::default())
      .await
      .expect("same work replay");
    assert!(!replay_inserted, "same durable intent must not duplicate waiting work");
    let (_, waiting) = q.list_jobs(qn, "waiting", 0, 10).await.expect("waiting jobs");
    assert_eq!(waiting, 1);

    let conflict = q
      .enqueue_idempotent(
        qn,
        job_id,
        "git-sync.syncRun",
        serde_json::json!({"runId": "different"}),
        JobOptions::default(),
      )
      .await
      .expect_err("same id must reject different work");
    assert!(matches!(conflict, QueueError::IdempotencyConflict { .. }));

    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");
    q.fail(
      qn,
      &job.id,
      "worker stopped before durable owner was claimed",
      None,
      TerminalRetentionPolicy::default(),
    )
    .await
    .expect("terminal delivery failure");
    let (_, recovered) = q
      .enqueue_idempotent(qn, job_id, "git-sync.syncRun", data, JobOptions::default())
      .await
      .expect("replay terminal delivery");
    assert!(
      recovered,
      "durable Pending owner must be able to replay failed delivery"
    );
    let (_, waiting) = q.list_jobs(qn, "waiting", 0, 10).await.expect("recovered jobs");
    let (_, failed) = q.list_jobs(qn, "failed", 0, 10).await.expect("failed jobs");
    assert_eq!(waiting, 1);
    assert_eq!(failed, 0);
    let mut conn = q.connection().await.expect("retention connection");
    let retained: Option<i64> = conn
      .zscore(q.terminal_retention_key(qn, "failed"), job_id)
      .await
      .expect("failed retention state");
    assert!(
      retained.is_none(),
      "recovered job must leave no stale failure retention"
    );

    q.empty_queue(qn).await.expect("remove recovered waiting job");
    let completed_id = "git-sync-run-completed";
    let completed_data = serde_json::json!({"runId": "completed"});
    q.enqueue_idempotent(
      qn,
      completed_id,
      "git-sync.syncRun",
      completed_data.clone(),
      JobOptions::default(),
    )
    .await
    .expect("enqueue job to complete");
    let completed_job = q.dequeue(qn, 1).await.expect("dequeue completed job").expect("job");
    q.ack(
      qn,
      &completed_job.id,
      Some(serde_json::json!({"suppressed":true})),
      TerminalRetentionPolicy {
        remove_on_complete: false,
        ..TerminalRetentionPolicy::default()
      },
    )
    .await
    .expect("retain completed job");
    let completed_snapshot = q
      .get_job(qn, completed_id)
      .await
      .expect("completed snapshot")
      .expect("retained job");
    assert!(completed_snapshot.finished_on.is_some());
    assert_eq!(
      completed_snapshot.return_value,
      Some(serde_json::json!({"suppressed":true})),
      "SQL handoff reconciliation needs the live outcome, not the enqueue-time snapshot"
    );
    let replay = q
      .enqueue_idempotent(
        qn,
        completed_id,
        "git-sync.syncRun",
        completed_data,
        JobOptions::default(),
      )
      .await
      .expect_err("completed delivery must never be replayed");
    assert!(matches!(replay, QueueError::IdempotencyConflict { .. }));

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Ack
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn ack_removes_job_from_active_list() {
    let q = test_queue().await;
    let qn = "q-ack";

    let job_id = q
      .enqueue(qn, "ack-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");

    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");
    assert_eq!(job.id, job_id);

    q.ack(qn, &job_id, None, TerminalRetentionPolicy::default())
      .await
      .expect("ack");

    // Verify active list is empty.
    let mut conn = q.connection().await.expect("conn");
    let active_len: i64 = conn.llen(q.key(qn, "active")).await.expect("llen active");
    assert_eq!(active_len, 0, "active list must be empty after ack");
    let completed_len: i64 = conn.scard(q.key(qn, "completed")).await.expect("scard completed");
    let job_exists: bool = conn
      .exists(q.job_key(qn, &job_id))
      .await
      .expect("completed job hash exists");
    assert_eq!(
      completed_len, 0,
      "default removeOnComplete must not retain status entries"
    );
    assert!(
      !job_exists,
      "default removeOnComplete must delete the completed job hash"
    );

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Fail
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn fail_job_with_retry_at_requeues_to_delayed() {
    let q = test_queue().await;
    let qn = "q-fail-retry";

    q.enqueue(qn, "fail-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");
    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");

    // Retry far in the future (10 seconds from now).
    let retry_at = chrono::Utc::now().timestamp_millis() + 10_000;
    q.fail(
      qn,
      &job.id,
      "something failed",
      Some(retry_at),
      TerminalRetentionPolicy::default(),
    )
    .await
    .expect("fail");

    // Job must no longer be in active.
    let mut conn = q.connection().await.expect("conn");
    let active_len: i64 = conn.llen(q.key(qn, "active")).await.expect("llen");
    assert_eq!(active_len, 0);

    // Job must be in delayed set.
    let delayed_count: i64 = conn.zcard(q.key(qn, "delayed")).await.expect("zcard");
    assert_eq!(delayed_count, 1, "failed job must be in delayed set for retry");

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn fail_job_permanently_moves_to_failed_set() {
    let q = test_queue().await;
    let qn = "q-fail-perm";

    q.enqueue(qn, "perm-fail-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");
    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");

    // No retry_at → permanent failure.
    q.fail(qn, &job.id, "permanent error", None, TerminalRetentionPolicy::default())
      .await
      .expect("fail");

    let mut conn = q.connection().await.expect("conn");
    let failed_count: i64 = conn.scard(q.key(qn, "failed")).await.expect("scard");
    assert_eq!(failed_count, 1, "permanently failed job must be in failed set");
    let retained_score: Option<i64> = conn
      .zscore(q.terminal_retention_key(qn, "failed"), &job.id)
      .await
      .expect("zscore failed retention");
    assert!(retained_score.is_some(), "failed job must be indexed for retention");

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn failed_retention_prunes_oldest_status_and_job_hashes() {
    let q = test_queue().await;
    let qn = "q-retention";
    let mut conn = q.connection().await.expect("conn");
    let status_key = q.key(qn, "failed");
    let retention_key = q.terminal_retention_key(qn, "failed");

    for (id, score) in [("1", 1_000), ("2", 2_000), ("3", 3_000), ("4", 4_000)] {
      let _: () = conn.sadd(&status_key, id).await.expect("sadd failed");
      let _: () = conn.zadd(&retention_key, id, score).await.expect("zadd retention");
      let _: () = conn
        .hset(q.job_key(qn, id), "finishedOn", score)
        .await
        .expect("hset finishedOn");
    }

    let removed = q
      .prune_failed_jobs_with_policy(qn, 1_500, 2, 100)
      .await
      .expect("prune terminal jobs");
    assert_eq!(removed, 2, "age and maximum count must remove the two oldest jobs");

    let remaining: Vec<String> = conn.smembers(&status_key).await.expect("remaining failed");
    assert_eq!(remaining.len(), 2);
    assert!(remaining.contains(&"3".to_string()));
    assert!(remaining.contains(&"4".to_string()));
    let oldest_exists: bool = conn.exists(q.job_key(qn, "1")).await.expect("oldest exists");
    let second_exists: bool = conn.exists(q.job_key(qn, "2")).await.expect("second exists");
    assert!(!oldest_exists && !second_exists, "pruned job hashes must be deleted");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Delayed jobs
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn enqueue_delayed_job_not_immediately_dequeued() {
    let q = test_queue().await;
    let qn = "q-delayed";

    // Delay of 5 000 ms — should not be visible in the wait list yet.
    let opts = JobOptions {
      delay_ms: Some(5_000),
      ..Default::default()
    };
    q.enqueue(qn, "delayed-job", serde_json::json!({}), opts)
      .await
      .expect("enqueue");

    // Dequeue with 1-second timeout should return nothing (job is still delayed).
    let result = q.dequeue(qn, 1).await.expect("dequeue");
    assert!(result.is_none(), "delayed job must not be immediately dequeued");

    // Verify it is in the delayed sorted set.
    let mut conn = q.connection().await.expect("conn");
    let delayed_count: i64 = conn.zcard(q.key(qn, "delayed")).await.expect("zcard");
    assert_eq!(delayed_count, 1, "delayed job must be in delayed sorted set");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // FIFO order
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn multiple_enqueue_preserves_fifo_order() {
    let q = test_queue().await;
    let qn = "q-fifo";

    for name in &["job_a", "job_b", "job_c"] {
      q.enqueue(qn, name, serde_json::json!({}), JobOptions::default())
        .await
        .expect("enqueue");
    }

    let mut dequeued_names = Vec::new();
    for _ in 0..3 {
      let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");
      dequeued_names.push(job.name.clone());
      q.ack(qn, &job.id, None, TerminalRetentionPolicy::default())
        .await
        .expect("ack");
    }

    assert_eq!(
      dequeued_names,
      vec!["job_a", "job_b", "job_c"],
      "jobs must be dequeued in FIFO order"
    );

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Auto-incrementing IDs
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn job_id_is_auto_incrementing() {
    let q = test_queue().await;
    let qn = "q-ids";

    let id1 = q
      .enqueue(qn, "job1", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue 1");
    let id2 = q
      .enqueue(qn, "job2", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue 2");

    let n1: i64 = id1.parse().expect("numeric id");
    let n2: i64 = id2.parse().expect("numeric id");
    assert!(n2 > n1, "job IDs must be strictly ascending: {n1} < {n2}");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Queue stats
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn queue_stats_reflects_enqueued_jobs() {
    let q = test_queue().await;
    let qn = "q-stats";

    q.enqueue(qn, "s1", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");
    q.enqueue(qn, "s2", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");

    let stats = q.queue_stats(qn).await.expect("stats");
    assert_eq!(stats.waiting, 2);
    assert_eq!(stats.active, 0);
    assert_eq!(stats.failed, 0);
    assert!(!stats.degraded, "degraded must be false when all stats succeed");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Delayed promotion
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn promote_delayed_moves_due_jobs_to_wait() {
    let q = test_queue().await;
    let qn = "q-promote";

    // Enqueue with negative delay so the job is already due.
    let opts = JobOptions {
      delay_ms: Some(-1),
      ..Default::default()
    };
    q.enqueue(qn, "due-job", serde_json::json!({}), opts)
      .await
      .expect("enqueue");

    let promoted = q.promote_delayed(qn).await.expect("promote");
    assert_eq!(promoted, 1, "one delayed job should have been promoted");

    // Now it should be dequeue-able.
    let job = q.dequeue(qn, 1).await.expect("dequeue").expect("job");
    assert_eq!(job.name, "due-job");
    q.ack(qn, &job.id, None, TerminalRetentionPolicy::default())
      .await
      .expect("ack");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // WRK-RV-04b: Atomic dequeue discards jobs with missing hash
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn dequeue_missing_hash_does_not_stick_in_active() {
    let q = test_queue().await;
    let qn = "q-04b";

    // Manually push a job ID into the wait list WITHOUT creating its hash.
    let mut conn = q.connection().await.expect("conn");
    let wait_key = q.key(qn, "wait");
    let active_key = q.key(qn, "active");
    let _: () = conn.lpush(&wait_key, "ghost-42").await.expect("lpush");

    // Also enqueue a real job so dequeue can return something after skipping the ghost.
    q.enqueue(qn, "real-job", serde_json::json!({"ok": true}), JobOptions::default())
      .await
      .expect("enqueue");

    // Dequeue should skip the ghost and return the real job.
    let job = q.dequeue(qn, 2).await.expect("dequeue").expect("real job");
    assert_eq!(job.name, "real-job");

    // The active list must contain only the real job, not the ghost.
    let active_ids: Vec<String> = conn.lrange(&active_key, 0, -1).await.expect("lrange");
    assert_eq!(active_ids.len(), 1, "only the real job should be in active");
    assert_eq!(active_ids[0], job.id);

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // Orphan reconciliation (WRK-RV-02b)
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn reconcile_removes_orphaned_job_hashes() {
    let q = test_queue().await;
    let qn = "q-orphan";

    // Enqueue a normal job (this will be in the wait list — NOT orphaned).
    q.enqueue(qn, "legit-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");

    // Manually create an orphaned job hash (no queue entry).
    let orphan_key = q.job_key(qn, "99999");
    let mut conn = q.connection().await.expect("conn");
    let _: () = conn
      .hset_multiple(&orphan_key, &[("name", "orphan-job"), ("data", "{}"), ("opts", "{}")])
      .await
      .expect("hset orphan");

    // Verify the orphan key exists.
    let exists: bool = conn.exists(&orphan_key).await.expect("exists");
    assert!(exists, "orphan key must exist before reconciliation");

    // Run reconciliation.
    let cleaned = q.reconcile_orphaned_jobs(qn).await.expect("reconcile");
    assert_eq!(cleaned, 1, "should clean up exactly 1 orphaned job");

    // Verify the orphan key was deleted.
    let exists_after: bool = conn.exists(&orphan_key).await.expect("exists");
    assert!(!exists_after, "orphan key must be deleted after reconciliation");

    // Verify the legitimate job is still in the wait list.
    let wait_len: i64 = conn.llen(q.key(qn, "wait")).await.expect("llen");
    assert_eq!(wait_len, 1, "legitimate job must still be in wait list");

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn reconcile_no_orphans_returns_zero() {
    let q = test_queue().await;
    let qn = "q-no-orphan";

    // Enqueue a normal job.
    q.enqueue(qn, "normal-job", serde_json::json!({}), JobOptions::default())
      .await
      .expect("enqueue");

    let cleaned = q.reconcile_orphaned_jobs(qn).await.expect("reconcile");
    assert_eq!(cleaned, 0, "no orphans should be found");

    cleanup(&q, qn).await;
  }

  // -----------------------------------------------------------------------
  // list_jobs
  // -----------------------------------------------------------------------

  #[tokio::test]
  async fn list_jobs_returns_waiting_jobs_with_data() {
    let q = test_queue().await;
    let qn = "q-list-wait";

    let id1 = q
      .enqueue(qn, "alpha", serde_json::json!({"x": 1}), JobOptions::default())
      .await
      .expect("test: enqueue alpha");
    let id2 = q
      .enqueue(qn, "beta", serde_json::json!({"x": 2}), JobOptions::default())
      .await
      .expect("test: enqueue beta");

    let (jobs, total) = q.list_jobs(qn, "waiting", 0, 10).await.expect("test: list_jobs");
    assert_eq!(total, 2);
    assert_eq!(jobs.len(), 2);
    // Jobs should have id and name fields
    let ids: Vec<&str> = jobs
      .iter()
      .filter_map(|j| j.get("id").and_then(|v| v.as_str()))
      .collect();
    assert!(ids.contains(&id1.as_str()));
    assert!(ids.contains(&id2.as_str()));

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn list_jobs_pagination_works() {
    let q = test_queue().await;
    let qn = "q-list-page";

    for i in 0..5 {
      q.enqueue(qn, &format!("j{i}"), serde_json::json!({}), JobOptions::default())
        .await
        .expect("test: enqueue");
    }

    let (page1, total) = q.list_jobs(qn, "waiting", 0, 2).await.expect("test: list_jobs page1");
    assert_eq!(total, 5);
    assert_eq!(page1.len(), 2);

    let (page2, _) = q.list_jobs(qn, "waiting", 2, 2).await.expect("test: list_jobs page2");
    assert_eq!(page2.len(), 2);

    let (page3, _) = q.list_jobs(qn, "waiting", 4, 2).await.expect("test: list_jobs page3");
    assert_eq!(page3.len(), 1);

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn list_jobs_empty_queue_returns_zero() {
    let q = test_queue().await;
    let qn = "q-list-empty";

    let (jobs, total) = q.list_jobs(qn, "waiting", 0, 10).await.expect("test: list_jobs empty");
    assert_eq!(total, 0);
    assert!(jobs.is_empty());

    cleanup(&q, qn).await;
  }

  #[tokio::test]
  async fn list_jobs_unknown_status_returns_empty() {
    let q = test_queue().await;
    let qn = "q-list-unknown";

    let (jobs, total) = q
      .list_jobs(qn, "nonexistent", 0, 10)
      .await
      .expect("test: list_jobs nonexistent");
    assert_eq!(total, 0);
    assert!(jobs.is_empty());

    cleanup(&q, qn).await;
  }
}
