// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded stopped-owner repeat import. Redis reads never hold a SQL write
//! transaction. Existing queue IDs are receipts, not re-enqueue instructions.
use super::*;
use myoxus_domain::scheduling::registered::RegisteredJob;
use redis::AsyncCommands;
use std::collections::{BTreeMap, BTreeSet};

const QUEUE_LIMIT: isize = 100_000;
const PAYLOAD_LIMIT: usize = 256 * 1024;
const IMPORT_BYTE_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct ImportReport {
  pub retained: usize,
  pub deduplicated: usize,
}

struct LegacyJob {
  id: String,
  slot: DateTime<Utc>,
  protected: bool,
  fields: BTreeMap<String, String>,
}

/// Keep this guard through registration, before workers/admission start. Its
/// dedicated session closes on cancellation/error, releasing the replica lock;
/// it must never return an advisory-locked connection to the pool.
pub struct RegisteredStartup {
  ownership: sqlx::pool::PoolConnection<sqlx::Postgres>,
  pool: PgPool,
  redis: redis::aio::ConnectionManager,
  prefix: String,
}

impl RegisteredStartup {
  #[tracing::instrument(skip_all)]
  pub async fn acquire(pool: &PgPool, client: redis::Client, prefix: String) -> RepoResult<Self> {
    if prefix.is_empty() || prefix.len() > 256 {
      return Err(blocked("registeredQueueNamespaceInvalid"));
    }
    let mut ownership = pool.acquire().await.map_err(storage)?;
    ownership.close_on_drop();
    sqlx::query("SELECT pg_advisory_lock(hashtextextended('myoxus:registered-worker-cutover',0))")
      .execute(&mut *ownership)
      .await
      .map_err(storage)?;
    let redis = client
      .get_connection_manager_with_config(redis::aio::ConnectionManagerConfig::new().set_number_of_retries(0))
      .await
      .map_err(|_| blocked("registeredQueueUnavailable"))?;
    Ok(Self {
      ownership,
      pool: pool.clone(),
      redis,
      prefix,
    })
  }

  /// Process the complete allowlist, including currently disabled metrics
  /// registrations. SQL commits precede exact duplicate/tracking cleanup; a
  /// restart can repeat either side without replacing a retained native job.
  #[tracing::instrument(skip_all)]
  pub async fn import_pending(&mut self, now: DateTime<Utc>) -> RepoResult<ImportReport> {
    tokio::time::timeout(std::time::Duration::from_secs(60), self.import_owned(now))
      .await
      .map_err(|_| blocked("registeredImportTimeBudgetExceeded"))?
  }

  async fn import_owned(&mut self, now: DateTime<Utc>) -> RepoResult<ImportReport> {
    let mut report = ImportReport::default();
    let mut queues: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut pending_count = 0;
    let mut bytes = 0;
    for job in RegisteredJob::ALL {
      if !queues.contains_key(job.queue()) {
        let ids = self.pending_ids(job.queue()).await?;
        pending_count += ids.len();
        bytes += ids.iter().map(String::len).sum::<usize>();
        if pending_count > QUEUE_LIMIT as usize || bytes > IMPORT_BYTE_LIMIT {
          return Err(blocked("registeredImportBudgetExceeded"));
        }
        queues.insert(job.queue(), ids);
      }
    }
    for job in RegisteredJob::ALL {
      let tracking = format!("cron:{}:{}", job.queue(), job.name());
      let raw: Option<String> = self
        .redis
        .get(&tracking)
        .await
        .map_err(|_| blocked("registeredTrackingReadUnavailable"))?;
      let track = raw.as_ref().map(|value| parse_slot(value)).transpose()?;
      let mut slots: BTreeMap<DateTime<Utc>, Vec<LegacyJob>> = BTreeMap::new();
      for id in &queues[job.queue()] {
        if let Some(found) = self.read_job(*job, id).await? {
          bytes += found
            .fields
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();
          if bytes > IMPORT_BYTE_LIMIT {
            return Err(blocked("registeredImportBudgetExceeded"));
          }
          slots.entry(found.slot).or_default().push(found)
        }
      }
      let mut retained = Vec::new();
      let mut duplicates = Vec::new();
      for (_, mut copies) in slots {
        copies.sort_by(|a, b| a.id.cmp(&b.id));
        let protected = copies.iter().any(|copy| copy.protected);
        let mut kept = false;
        for copy in copies {
          if copy.protected || (!protected && !kept) {
            kept = true;
            retained.push(copy)
          } else {
            duplicates.push(copy)
          }
        }
      }
      let anchor = retained
        .iter()
        .map(|copy| copy.slot)
        .chain(track)
        .filter(|slot| *slot > now)
        .max();
      let target = serde_json::to_value(ScheduleTarget::RegisteredJob { job: *job }).map_err(storage)?;
      let nominal = anchor
        .map(|at| serde_json::to_value(ScheduleValue::LocalDateTime(at.naive_utc())))
        .transpose()
        .map_err(storage)?;
      let mut tx = self.pool.begin().await.map_err(storage)?;
      // Existence is the source-import receipt, not a second migration ledger.
      // A later startup must not rewind a live registered cursor from Redis.
      sqlx::query("INSERT INTO scheduling_schedules(id,admission_zone,target_json,lifecycle,next_nominal,next_due_at,next_admission_at) VALUES($1,'UTC',$2,'ended',$3,$4,$4) ON CONFLICT(id) DO NOTHING")
        .bind(job.schedule_id()).bind(&target).bind(nominal).bind(anchor).execute(&mut *tx).await.map_err(storage)?;
      let current: serde_json::Value =
        sqlx::query_scalar("SELECT target_json FROM scheduling_schedules WHERE id=$1 FOR UPDATE")
          .bind(job.schedule_id())
          .fetch_one(&mut *tx)
          .await
          .map_err(storage)?;
      if current != target {
        return Err(blocked("registeredScheduleOwnerMismatch"));
      }
      for copy in &retained {
        let dispatch = Uuid::new_v5(&job.schedule_id(), format!("native:{}", copy.id).as_bytes());
        // A historical slot may already have multiple started native deliveries.
        // Keep each frozen dispatch reference, with its same nominal_due_at;
        // never weaken the fixed-slot uniqueness used by Tasks and Git Cron.
        let nominal = serde_json::json!({"kind":"native_repeat","scheduled_for":copy.slot,"job_id":copy.id});
        let written=sqlx::query("INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id,native_job_id) SELECT $1,$2,$3,$4,generation,$1,$5 FROM scheduling_schedules WHERE id=$2 ON CONFLICT(id) DO UPDATE SET native_job_id=EXCLUDED.native_job_id WHERE scheduling_occurrences.schedule_id=EXCLUDED.schedule_id AND scheduling_occurrences.native_job_id=EXCLUDED.native_job_id AND scheduling_occurrences.nominal_due_at=EXCLUDED.nominal_due_at")
          .bind(dispatch).bind(job.schedule_id()).bind(nominal).bind(copy.slot).bind(&copy.id).execute(&mut *tx).await.map_err(storage)?;
        if written.rows_affected() != 1 {
          return Err(blocked("registeredNativeDispatchMismatch"));
        }
      }
      tx.commit().await.map_err(storage)?;
      report.retained += retained.len();
      for copy in duplicates {
        self.remove_duplicate(*job, &copy).await?;
        report.deduplicated += 1;
      }
      // Compare-and-delete preserves a changed timestamp and fails closed. No
      // old process is allowed to continue writing timing during this cutover.
      let removed:i64=redis::Script::new("local current=redis.call('GET',KEYS[1]);if not current then return 1 end;if current~=ARGV[1] then return 0 end;redis.call('DEL',KEYS[1]);return 1")
        .key(tracking).arg(raw.unwrap_or_default()).invoke_async(&mut self.redis).await.map_err(|_|blocked("registeredTrackingCleanupUnavailable"))?;
      if removed != 1 {
        return Err(blocked("registeredTrackingChangedDuringTransfer"));
      }
    }
    Ok(report)
  }

  pub async fn finish(mut self) -> RepoResult<()> {
    sqlx::query("SELECT pg_advisory_unlock(hashtextextended('myoxus:registered-worker-cutover',0))")
      .execute(&mut *self.ownership)
      .await
      .map_err(storage)?;
    Ok(())
  }

  /// Caller retains the same session guard while all startup-owned definitions
  /// are replaced; other replicas cannot start partial registration/admission.
  pub async fn register(
    &mut self,
    workers: Vec<myoxus_domain::scheduling::registered::RegisteredWorker>,
    now: DateTime<Utc>,
  ) -> RepoResult<usize> {
    let count = super::registered::register(&self.pool, workers, now).await?;
    redis::cmd("DEL")
      .arg(format!("{}:cron:scheduler:leader", self.prefix))
      .query_async::<usize>(&mut self.redis)
      .await
      .map_err(|_| blocked("registeredLegacyLeaseCleanupUnavailable"))?;
    Ok(count)
  }

  async fn pending_ids(&mut self, queue: &str) -> RepoResult<Vec<String>> {
    let mut ids = BTreeSet::new();
    for kind in ["wait", "active", "delayed"] {
      let key = format!("{}:{}:{kind}", self.prefix, queue);
      let found: Vec<String> = if kind == "delayed" {
        self.redis.zrange(&key, 0, QUEUE_LIMIT).await
      } else {
        self.redis.lrange(&key, 0, QUEUE_LIMIT).await
      }
      .map_err(|_| blocked("registeredQueueReadUnavailable"))?;
      if found.len() > QUEUE_LIMIT as usize {
        return Err(blocked("registeredQueueImportBudgetExceeded"));
      }
      ids.extend(found);
      if ids.len() > QUEUE_LIMIT as usize {
        return Err(blocked("registeredQueueImportBudgetExceeded"));
      }
    }
    Ok(ids.into_iter().collect())
  }

  async fn read_job(&mut self, job: RegisteredJob, id: &str) -> RepoResult<Option<LegacyJob>> {
    if id.is_empty() || id.len() > 256 {
      return Err(blocked("registeredNativeJobIdInvalid"));
    }
    let key = format!("{}:{}:{id}", self.prefix, job.queue());
    let name: Option<String> = self
      .redis
      .hget(&key, "name")
      .await
      .map_err(|_| blocked("registeredJobReadUnavailable"))?;
    if name.as_deref() != Some(job.name()) {
      return Ok(None);
    }
    let fields: BTreeMap<String, String> = self
      .redis
      .hgetall(&key)
      .await
      .map_err(|_| blocked("registeredJobReadUnavailable"))?;
    if fields.get("name").map(String::as_str) != Some(job.name()) {
      return Err(blocked("registeredJobChangedDuringTransfer"));
    }
    if fields.len() > 64 || fields.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > PAYLOAD_LIMIT {
      return Err(blocked("registeredJobPayloadBudgetExceeded"));
    }
    let Some(opts) = fields.get("opts") else {
      return Err(blocked("registeredJobOptionsMissing"));
    };
    let opts: serde_json::Value = serde_json::from_str(opts).map_err(|_| blocked("registeredJobOptionsInvalid"))?;
    let Some(repeat) = opts.get("repeat").filter(|value| !value.is_null()) else {
      return Ok(None);
    };
    let identity = repeat
      .get("job_id")
      .and_then(serde_json::Value::as_str)
      .ok_or_else(|| blocked("registeredRepeatIdentityMissing"))?;
    let slot = identity
      .strip_prefix(&format!("repeat:{}:", job.name()))
      .ok_or_else(|| blocked("registeredRepeatIdentityMismatch"))?;
    let slot = parse_slot(slot)?;
    let attempts = fields
      .get("attemptsMade")
      .ok_or_else(|| blocked("registeredJobAttemptsMissing"))?
      .parse::<u32>()
      .map_err(|_| blocked("registeredJobAttemptsInvalid"))?;
    let active: Option<isize> = redis::cmd("LPOS")
      .arg(format!("{}:{}:active", self.prefix, job.queue()))
      .arg(id)
      .query_async(&mut self.redis)
      .await
      .map_err(|_| blocked("registeredActiveReadUnavailable"))?;
    let execution_metadata = ["heartbeat", "finishedOn", "failedReason"]
      .iter()
      .any(|key| fields.get(*key).is_some_and(|value| !value.is_empty()));
    Ok(Some(LegacyJob {
      id: id.to_owned(),
      slot,
      protected: attempts > 0 || active.is_some() || execution_metadata,
      fields,
    }))
  }

  async fn remove_duplicate(&mut self, job: RegisteredJob, copy: &LegacyJob) -> RepoResult<()> {
    let script = redis::Script::new(
      r#"
      if redis.call('EXISTS',KEYS[1])==0 then return 1 end
      if redis.call('LPOS',KEYS[3],ARGV[1]) then return 0 end
      if redis.call('HLEN',KEYS[1])~=tonumber(ARGV[2]) then return 0 end
      for i=3,#ARGV,2 do if redis.call('HGET',KEYS[1],ARGV[i])~=ARGV[i+1] then return 0 end end
      redis.call('LREM',KEYS[2],0,ARGV[1]);redis.call('ZREM',KEYS[4],ARGV[1]);redis.call('DEL',KEYS[1]);return 1
    "#,
    );
    let mut invocation = script.prepare_invoke();
    invocation
      .key(format!("{}:{}:{}", self.prefix, job.queue(), copy.id))
      .key(format!("{}:{}:wait", self.prefix, job.queue()))
      .key(format!("{}:{}:active", self.prefix, job.queue()))
      .key(format!("{}:{}:delayed", self.prefix, job.queue()))
      .arg(&copy.id)
      .arg(copy.fields.len());
    for (key, value) in &copy.fields {
      invocation.arg(key).arg(value);
    }
    let result: i64 = invocation
      .invoke_async(&mut self.redis)
      .await
      .map_err(|_| blocked("registeredDuplicateCleanupUnavailable"))?;
    if result != 1 {
      return Err(blocked("registeredDuplicateChangedDuringTransfer"));
    }
    Ok(())
  }
}

fn parse_slot(value: &str) -> RepoResult<DateTime<Utc>> {
  let millis = value
    .parse::<i64>()
    .ok()
    .filter(|value| *value > 0)
    .ok_or_else(|| blocked("registeredLegacySlotInvalid"))?;
  DateTime::from_timestamp_millis(millis).ok_or_else(|| blocked("registeredLegacySlotInvalid"))
}
