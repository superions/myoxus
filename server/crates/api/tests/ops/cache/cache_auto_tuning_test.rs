//! Integration tests for cache TTL auto-tuning (P84-J-22/23).
//!
//! These tests call the tuning cycle directly (bypassing the 1h/24h timer) and
//! verify DB state and TTL atomic updates.

use crate::helpers;

use myoxus_api::cache::{CacheConfig, QueryCache};
use myoxus_api::cache_tuning::run_hourly_cycle_once;
use myoxus_application::metrics::{InMemoryMetricsRecorder, MetricsPolicy, MetricsService};
use myoxus_domain::metrics::MetricsRepository;
use myoxus_infrastructure::metrics::SqlxMetricsRepository;
use std::sync::{Arc, Mutex};

fn metrics_service(pool: &sqlx::PgPool) -> MetricsService {
  let recorder = Arc::new(InMemoryMetricsRecorder::new(MetricsPolicy::default()));
  let repository: Arc<dyn MetricsRepository> = Arc::new(SqlxMetricsRepository::new(pool.clone()));
  MetricsService::new(recorder, repository)
}

/// INV-TUNING-05 (P84-J-22): Max 24h change cap — TTL cannot grow beyond 4× the
/// baseline from 24h ago, even when hit rate is extremely low.
#[tokio::test]
async fn inv_max_24h_change_capped_at_factor_4() {
  let _guard = helpers::CACHE_TUNING_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .expect("cache tuning lock");
  let pool = helpers::setup_pool().await;
  let config = CacheConfig::default();
  let cache = QueryCache::new(&config);

  // Seed a baseline record ~24h ago with current_ttl = 100s.
  let baseline_ttl: i32 = 100;
  sqlx::query(
    r#"INSERT INTO cache_tuning_metrics
           (cache_name, hits, misses, hit_rate, invalidations_local, invalidations_remote,
            current_ttl_seconds, recommended_ttl_seconds, action_taken, cycle_type, measured_at)
           VALUES ('server_config', 50, 50, 0.5, 0, 0, $1, $1, 'unchanged', 'hourly',
                   NOW() - INTERVAL '24 hours')"#,
  )
  .bind(baseline_ttl)
  .execute(&pool)
  .await
  .expect("seed 24h baseline failed");

  // Simulate 1% hit rate on server_config — rules would recommend a large increase.
  for _ in 0..2 {
    cache.metrics_server_config.record_hit();
  }
  for _ in 0..198 {
    cache.metrics_server_config.record_miss();
  }

  run_hourly_cycle_once(&cache, &config, &metrics_service(&pool)).await;

  // The recommended TTL must not exceed baseline × 4 = 400.
  let row: Option<(i32,)> = sqlx::query_as(
    r#"SELECT recommended_ttl_seconds FROM cache_tuning_metrics
           WHERE cache_name = 'server_config' AND cycle_type = 'hourly'
           ORDER BY measured_at DESC LIMIT 1"#,
  )
  .fetch_optional(&pool)
  .await
  .expect("query recommended TTL failed");

  let recommended = row.expect("no record persisted").0;
  assert!(
    recommended <= baseline_ttl * 4,
    "recommended_ttl ({recommended}) must not exceed 4× baseline ({}) = {}",
    baseline_ttl,
    baseline_ttl * 4
  );

  // Cleanup.
  sqlx::query("DELETE FROM cache_tuning_metrics WHERE cache_name = 'server_config'")
    .execute(&pool)
    .await
    .expect("cleanup failed");
}
