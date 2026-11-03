// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native delayed promotion and stalled-delivery recovery. Recurring timing
//! belongs to shared SQL scheduling, not another Redis registration/leader loop.
use crate::{JobConfigSnapshot, queue::RedisQueue};
use std::time::Duration;
use tokio::sync::watch;
use tracing::{debug, info, warn};

/// Promote delayed jobs and recover stalled native deliveries independently of
/// recurring admission. Heartbeat, retention and retry semantics stay native.
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
  let stall_interval_ms: i64 = 30_000;
  let mut ticker = tokio::time::interval(check_interval);
  ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
  loop {
    tokio::select! {
      changed=shutdown.changed()=>{if changed.is_err()||*shutdown.borrow(){break;}}
      _=ticker.tick()=>{
        for q in &queues{
          match queue.promote_delayed(q).await{
            Ok(n)if n>0=>debug!(queue=%q,promoted=n,"promoted delayed jobs"),
            Ok(_)=>{},
            Err(err)=>warn!(queue=%q,error=%err,"delayed promotion failed"),
          }
          match queue.check_stalled(q,stall_interval_ms).await{
            Ok(stalled)=>for job_id in stalled{
              let retention=config_watch.as_ref().map(|rx|rx.borrow().terminal_retention_policy()).unwrap_or_default();
              if let Err(err)=queue.recover_stalled_job(q,&job_id,retention).await{
                warn!(queue=%q,job_id=%job_id,error=%err,"stall recovery failed");
              }
            },
            Err(err)=>warn!(queue=%q,error=%err,"stall check failed"),
          }
        }
      }
    }
  }
  info!("delayed-job scheduler stopped");
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::{DateTime, Utc};
  use myoxus_domain::scheduling::{
    ScheduleTarget,
    registered::{RegisteredDispatch, RegisteredJob, RegisteredWorker},
  };
  use myoxus_infrastructure::scheduling::{registered, registered_import::RegisteredStartup};
  use sqlx::{PgPool, postgres::PgPoolOptions};
  use uuid::Uuid;

  fn clock() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap()
  }
  #[derive(Clone)]
  struct Fixture {
    admin: PgPool,
    pool: PgPool,
    database: String,
    queue: RedisQueue,
    job: RegisteredJob,
  }
  impl Fixture {
    async fn new() -> Self {
      let base = std::env::var("TEST_DATABASE_URL").expect("isolated scheduler test DB");
      let redis_url = std::env::var("REDIS_URL").expect("isolated worker Redis");
      let queue = RedisQueue::new(&redis_url, format!("registered-worker-{}", Uuid::new_v4().simple()))
        .expect("isolated native queue");
      let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&base)
        .await
        .expect("test DB admin");
      let database = format!("registered_worker_{}", Uuid::new_v4().simple());
      sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .expect("create isolated scheduler DB");
      let url = format!("{}/{database}", base.rsplit_once('/').expect("test DB URL").0);
      let pool = match PgPoolOptions::new().max_connections(5).connect(&url).await {
        Ok(pool) => pool,
        Err(error) => {
          sqlx::query(&format!("DROP DATABASE {database}"))
            .execute(&admin)
            .await
            .expect("remove failed setup database");
          panic!("isolated scheduler connection failed: {error}");
        }
      };
      let fixture = Self {
        admin,
        pool,
        database,
        queue,
        job: RegisteredJob::CountPendingUpdates,
      };
      if let Err(error) = myoxus_infrastructure::migrations::run(&fixture.pool).await {
        fixture.cleanup().await;
        panic!("native scheduler migration setup failed: {error}");
      }
      let setup = fixture.clone();
      let prepared = tokio::spawn(async move {
        for job in RegisteredJob::ALL {
          sqlx::query(
            "INSERT INTO scheduling_schedules(id,admission_zone,target_json,lifecycle) VALUES($1,'UTC',$2,'ended')",
          )
          .bind(job.schedule_id())
          .bind(serde_json::to_value(ScheduleTarget::RegisteredJob { job: *job }).unwrap())
          .execute(&setup.pool)
          .await
          .expect("prepared native registry source");
        }
      })
      .await;
      if let Err(error) = prepared {
        fixture.cleanup().await;
        panic!("scheduler fixture setup failed: {error}")
      }
      fixture
    }
    async fn register(&self, now: DateTime<Utc>, every_ms: u64) {
      let client = redis::Client::open(std::env::var("REDIS_URL").unwrap()).unwrap();
      let mut startup = RegisteredStartup::acquire(&self.pool, client, "unused-test-import".into())
        .await
        .expect("registration guard");
      let workers = RegisteredJob::ALL
        .iter()
        .map(|job| RegisteredWorker::interval(*job, every_ms, serde_json::json!({})).with_enabled(*job == self.job))
        .collect();
      startup
        .register(workers, now)
        .await
        .expect("shared startup registration");
      startup.finish().await.expect("release registration guard");
    }
    async fn fence(&self) -> (i64, i64) {
      sqlx::query_as("SELECT generation,revision FROM scheduling_schedules WHERE id=$1")
        .bind(self.job.schedule_id())
        .fetch_one(&self.pool)
        .await
        .expect("current scheduling fence")
    }
    async fn admit(&self, now: DateTime<Utc>) -> Option<usize> {
      let (generation, revision) = self.fence().await;
      registered::admit(&self.pool, self.job.schedule_id(), generation, revision, now)
        .await
        .expect("shared worker admission")
    }
    async fn handoff(&self) {
      let intents: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox_events WHERE event_type='registered_job_due' ORDER BY created_at,id",
      )
      .fetch_all(&self.pool)
      .await
      .expect("committed worker intents");
      for payload in intents {
        let delivery: RegisteredDispatch = serde_json::from_value(payload).expect("closed worker dispatch");
        assert!(registered::delivery_is_current(&self.pool, &delivery).await.unwrap());
        self
          .queue
          .enqueue_registered(&delivery)
          .await
          .expect("native stable queue delivery");
      }
    }
    async fn cleanup(self) {
      let queue_cleanup = self.queue.empty_queue(self.job.queue()).await;
      self.pool.close().await;
      let database_cleanup = sqlx::query(&format!("DROP DATABASE {}", self.database))
        .execute(&self.admin)
        .await;
      self.admin.close().await;
      queue_cleanup.expect("cleanup native worker jobs");
      database_cleanup.expect("drop isolated scheduler DB");
    }
  }

  #[tokio::test]
  async fn registered_scheduler_enqueues_job_with_every_ms() {
    let fixture = Fixture::new().await;
    let cleanup = fixture.clone();
    let result = tokio::spawn(async move {
      let now = clock();
      fixture.register(now, 60_000).await;
      assert_eq!(fixture.admit(now).await, Some(1));
      fixture.handoff().await;
      let stats = fixture.queue.queue_stats(fixture.job.queue()).await.unwrap();
      assert_eq!(
        stats.delayed, 1,
        "one future interval job, still using native delayed promotion"
      );
    })
    .await;
    cleanup.cleanup().await;
    result.expect("scheduler assertions");
  }

  #[tokio::test]
  async fn registered_scheduler_does_not_duplicate_jobs_within_window() {
    let fixture = Fixture::new().await;
    let cleanup = fixture.clone();
    let result = tokio::spawn(async move {
      let now = clock();
      fixture.register(now, 120_000).await;
      assert_eq!(fixture.admit(now).await, Some(1));
      assert_eq!(fixture.admit(now).await, None);
      fixture.handoff().await;
      fixture.handoff().await;
      let stats = fixture.queue.queue_stats(fixture.job.queue()).await.unwrap();
      assert_eq!(
        stats.delayed, 1,
        "SQL duplicate wake and lost outbox ACK reuse one native job"
      );
    })
    .await;
    cleanup.cleanup().await;
    result.expect("scheduler assertions");
  }

  #[tokio::test]
  async fn registered_scheduler_reschedules_from_current_time_after_outage() {
    let fixture = Fixture::new().await;
    let cleanup = fixture.clone();
    let result = tokio::spawn(async move {
      let now = clock();
      fixture.register(now - chrono::Duration::hours(4), 60_000).await;
      assert_eq!(fixture.admit(now).await, Some(1));
      fixture.handoff().await;
      let due: DateTime<Utc> = sqlx::query_scalar("SELECT next_due_at FROM scheduling_schedules WHERE id=$1")
        .bind(fixture.job.schedule_id())
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
      assert_eq!(
        due,
        now + chrono::Duration::seconds(60),
        "intervals skip unqueued backlog and reanchor at current admission"
      );
      assert_eq!(fixture.queue.queue_stats(fixture.job.queue()).await.unwrap().delayed, 1);
    })
    .await;
    cleanup.cleanup().await;
    result.expect("scheduler assertions");
  }

  #[tokio::test]
  async fn registered_scheduler_serializes_replicas_and_recovers_without_redis_leader() {
    let fixture = Fixture::new().await;
    let cleanup = fixture.clone();
    let result = tokio::spawn(async move {
      let now = clock();
      fixture.register(now, 60_000).await;
      let (generation, revision) = fixture.fence().await;
      let (a, b) = tokio::join!(
        registered::admit(&fixture.pool, fixture.job.schedule_id(), generation, revision, now),
        registered::admit(&fixture.pool, fixture.job.schedule_id(), generation, revision, now)
      );
      assert_eq!(a.unwrap().unwrap_or(0) + b.unwrap().unwrap_or(0), 1);
      assert_eq!(
        registered::admit(
          &fixture.pool,
          fixture.job.schedule_id(),
          generation,
          revision,
          now + chrono::Duration::minutes(1)
        )
        .await
        .unwrap(),
        None,
        "a stale replica cannot overwrite the advanced cursor"
      );
      assert_eq!(fixture.admit(now + chrono::Duration::minutes(1)).await, Some(1));
      fixture.handoff().await;
      assert_eq!(
        fixture.queue.queue_stats(fixture.job.queue()).await.unwrap().delayed,
        2,
        "a current replica recovers the next slot without a Redis leader lease"
      );
    })
    .await;
    cleanup.cleanup().await;
    result.expect("scheduler assertions");
  }
}
