//! Integration tests for cache tuning metrics retention policy (P84-J-24).
//!
//! Verifies that `run_daily_cycle_once` deletes records older than the
//! retention thresholds (7 days hourly, 90 days daily).

use crate::helpers;

use myoxus_api::cache::{CacheConfig, QueryCache};
use myoxus_api::cache_tuning::run_daily_cycle_once;
use myoxus_application::metrics::{InMemoryMetricsRecorder, MetricsPolicy, MetricsService};
use myoxus_domain::metrics::MetricsRepository;
use myoxus_infrastructure::metrics::SqlxMetricsRepository;
use std::sync::{Arc, Mutex};

fn metrics_service(pool: &sqlx::PgPool) -> MetricsService {
  let recorder = Arc::new(InMemoryMetricsRecorder::new(MetricsPolicy::default()));
  let repository: Arc<dyn MetricsRepository> = Arc::new(SqlxMetricsRepository::new(pool.clone()));
  MetricsService::new(recorder, repository)
}

/// Helper to insert a `cache_tuning_metrics` row with a custom `measured_at`.
async fn insert_record(pool: &sqlx::PgPool, cache_name: &str, cycle_type: &str, days_ago: i64) {
  sqlx::query(
    r#"INSERT INTO cache_tuning_metrics
           (cache_name, hits, misses, hit_rate, invalidations_local, invalidations_remote,
            current_ttl_seconds, recommended_ttl_seconds, action_taken, cycle_type, measured_at)
           VALUES ($1, 100, 100, 0.5, 0, 0, 300, 300, 'unchanged', $2,
                   NOW() - ($3::int * INTERVAL '1 day'))"#,
  )
  .bind(cache_name)
  .bind(cycle_type)
  .bind(days_ago as i32)
  .execute(pool)
  .await
  .expect("insert test record failed");
}

/// INV-RETENTION-01: Hourly records older than 7 days are deleted after daily cycle.
#[tokio::test]
async fn inv_hourly_records_deleted_after_7_days() {
  let _guard = helpers::CACHE_TUNING_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  // Pre-cleanup: remove stale records from previous runs that may conflict.
  sqlx::query("DELETE FROM cache_tuning_metrics WHERE cache_name = 'server_config'")
    .execute(&pool)
    .await
    .expect("clear server-config cache tuning metrics");
  let config = CacheConfig::default();
  let cache = QueryCache::new(&config);

  // Insert one record from 8 days ago (should be deleted) and one from 6 days ago (keep).
  insert_record(&pool, "server_config", "hourly", 8).await;
  insert_record(&pool, "server_config", "hourly", 6).await;

  // Run daily cycle (triggers retention cleanup).
  run_daily_cycle_once(&cache, &config, &metrics_service(&pool)).await;

  // Count remaining hourly records for the retained server-config cache.
  let count: (i64,) = sqlx::query_as(
    r#"SELECT COUNT(*) FROM cache_tuning_metrics
           WHERE cache_name = 'server_config' AND cycle_type = 'hourly'"#,
  )
  .fetch_one(&pool)
  .await
  .expect("count query failed");

  // The 8-day-old record should be gone; the 6-day-old record should remain.
  // Plus the daily cycle itself inserts new hourly-style records (cycle_type='hourly' from
  // the hourly task, not this). The daily cycle inserts 'daily' records. So only 1 hourly
  // record from 6 days ago should remain.
  assert!(
    count.0 >= 1,
    "6-day-old hourly record should still exist, count = {}",
    count.0
  );

  // The 8-day-old one must be gone.
  let old: (i64,) = sqlx::query_as(
    r#"SELECT COUNT(*) FROM cache_tuning_metrics
           WHERE cache_name = 'server_config' AND cycle_type = 'hourly'
             AND measured_at < NOW() - INTERVAL '7 days'"#,
  )
  .fetch_one(&pool)
  .await
  .expect("count old query failed");
  assert_eq!(
    old.0, 0,
    "hourly records older than 7 days should have been deleted, found {}",
    old.0
  );

  // Cleanup.
  sqlx::query("DELETE FROM cache_tuning_metrics WHERE cache_name = 'server_config'")
    .execute(&pool)
    .await
    .expect("cleanup failed");
}

/// INV-RETENTION-02: Daily records within 90 days are kept; older ones are deleted.
#[tokio::test]
async fn inv_daily_records_kept_for_90_days() {
  let _guard = helpers::CACHE_TUNING_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let pool = helpers::setup_pool().await;
  // Pre-cleanup: remove stale records from previous runs that may conflict.
  sqlx::query("DELETE FROM cache_tuning_metrics WHERE cache_name = 'server_config'")
    .execute(&pool)
    .await
    .expect("clear server-config cache tuning metrics");
  let config = CacheConfig::default();
  let cache = QueryCache::new(&config);

  // Insert a 89-day-old daily record (should survive) and a 91-day-old one (should go).
  insert_record(&pool, "server_config", "daily", 89).await;
  insert_record(&pool, "server_config", "daily", 91).await;

  // Run daily cycle — triggers retention cleanup.
  run_daily_cycle_once(&cache, &config, &metrics_service(&pool)).await;

  // 91-day-old must be gone.
  let old_daily: (i64,) = sqlx::query_as(
    r#"SELECT COUNT(*) FROM cache_tuning_metrics
           WHERE cache_name = 'server_config' AND cycle_type = 'daily'
             AND measured_at < NOW() - INTERVAL '90 days'"#,
  )
  .fetch_one(&pool)
  .await
  .expect("count old daily query failed");
  assert_eq!(
    old_daily.0, 0,
    "daily records older than 90 days should be deleted, found {}",
    old_daily.0
  );

  // 89-day-old must still be there.
  let recent: (i64,) = sqlx::query_as(
    r#"SELECT COUNT(*) FROM cache_tuning_metrics
           WHERE cache_name = 'server_config' AND cycle_type = 'daily'
             AND measured_at > NOW() - INTERVAL '90 days'"#,
  )
  .fetch_one(&pool)
  .await
  .expect("count recent query failed");
  // At minimum the 89-day-old seeded record + records from the daily cycle itself.
  assert!(
    recent.0 >= 1,
    "89-day-old daily record should survive, count = {}",
    recent.0
  );

  // Cleanup.
  sqlx::query("DELETE FROM cache_tuning_metrics WHERE cache_name = 'server_config'")
    .execute(&pool)
    .await
    .expect("cleanup failed");
}
