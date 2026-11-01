// SPDX-License-Identifier: AGPL-3.0-or-later
//! Postgres adapter for the business-metrics pipeline.
//!
//! Twin of `telemetry::SqlxTelemetryRepository` but accumulates rather than
//! discarding on conflict: each `(minute, category, metric_name, labels)`
//! bucket is UPSERTed with `value = metrics_raw.value + EXCLUDED.value` so
//! that a retried flush after a partial failure converges on the correct
//! sum instead of double-counting or discarding (INV-MET-03).

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::Value;
use sqlx::PgPool;
use tracing::{error, instrument, trace};

use myoxus_domain::metrics::{
  CacheTuningHistorySample, CacheTuningRecord, CacheTuningSnapshot, MetricSample, MetricsRepository, MetricsStoreError,
  MetricsStoreResult,
};

fn map_db_err(err: sqlx::Error) -> MetricsStoreError {
  error!(error = %err, "database error in metrics repository");
  MetricsStoreError::Backend(err.to_string())
}

pub struct SqlxMetricsRepository {
  pool: PgPool,
}

impl SqlxMetricsRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

/// Recomputes one daily rollup while holding a transaction-scoped advisory lock.
///
/// The lock and mutation deliberately share one PostgreSQL transaction. This
/// avoids both pooled session-lock leaks and the deadlock that would occur if a
/// single-connection pool held the lock while the repository requested a
/// second connection. `None` means another instance currently owns the job.
pub async fn rollup_day_with_advisory_lock(
  pool: &PgPool,
  lock_id: i64,
  day: NaiveDate,
) -> MetricsStoreResult<Option<u64>> {
  let mut transaction = pool.begin().await.map_err(map_db_err)?;
  let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
    .bind(lock_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_db_err)?;
  if !acquired {
    transaction.rollback().await.map_err(map_db_err)?;
    return Ok(None);
  }

  let result = sqlx::query(
    r#"
    INSERT INTO metrics_daily (day, category, metric_name, labels, sum, count)
    SELECT
      $1::date AS day,
      category,
      metric_name,
      labels,
      SUM(value) AS sum,
      COUNT(*) AS count
    FROM metrics_raw
    WHERE minute >= $1::date::timestamptz
      AND minute <  ($1::date + INTERVAL '1 day')::timestamptz
    GROUP BY category, metric_name, labels
    ON CONFLICT (day, category, metric_name, labels)
    DO UPDATE SET sum = EXCLUDED.sum, count = EXCLUDED.count
    "#,
  )
  .bind(day)
  .execute(&mut *transaction)
  .await
  .map_err(map_db_err)?;
  transaction.commit().await.map_err(map_db_err)?;
  Ok(Some(result.rows_affected()))
}

/// Prunes raw and daily metrics under one cancellation-safe advisory lock.
///
/// Both deletes commit together. `None` means another server instance is
/// already performing retention for this metrics store.
pub async fn prune_with_advisory_lock(
  pool: &PgPool,
  lock_id: i64,
  raw_cutoff: DateTime<Utc>,
  daily_cutoff: NaiveDate,
) -> MetricsStoreResult<Option<(u64, u64)>> {
  let mut transaction = pool.begin().await.map_err(map_db_err)?;
  let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
    .bind(lock_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(map_db_err)?;
  if !acquired {
    transaction.rollback().await.map_err(map_db_err)?;
    return Ok(None);
  }

  let raw_deleted = sqlx::query("DELETE FROM metrics_raw WHERE minute < $1")
    .bind(raw_cutoff)
    .execute(&mut *transaction)
    .await
    .map_err(map_db_err)?
    .rows_affected();
  let daily_deleted = sqlx::query("DELETE FROM metrics_daily WHERE day < $1")
    .bind(daily_cutoff)
    .execute(&mut *transaction)
    .await
    .map_err(map_db_err)?
    .rows_affected();
  transaction.commit().await.map_err(map_db_err)?;
  Ok(Some((raw_deleted, daily_deleted)))
}

#[async_trait]
impl MetricsRepository for SqlxMetricsRepository {
  #[instrument(skip(self, samples), fields(batch_size = samples.len()))]
  async fn insert_minute_batch(&self, samples: &[MetricSample]) -> MetricsStoreResult<u64> {
    if samples.is_empty() {
      return Ok(0);
    }

    let len = samples.len();
    let mut minutes: Vec<DateTime<Utc>> = Vec::with_capacity(len);
    let mut categories: Vec<String> = Vec::with_capacity(len);
    let mut metric_names: Vec<String> = Vec::with_capacity(len);
    let mut labels_col: Vec<Value> = Vec::with_capacity(len);
    let mut values: Vec<f64> = Vec::with_capacity(len);
    for s in samples {
      minutes.push(s.minute);
      categories.push(s.category.clone());
      metric_names.push(s.metric_name.clone());
      labels_col.push(s.labels.clone());
      values.push(s.value);
    }

    let result = sqlx::query(
      r#"
      INSERT INTO metrics_raw (minute, category, metric_name, labels, value)
      SELECT * FROM UNNEST(
        $1::timestamptz[],
        $2::text[],
        $3::text[],
        $4::jsonb[],
        $5::float8[]
      )
      ON CONFLICT (minute, category, metric_name, labels)
      DO UPDATE SET value = metrics_raw.value + EXCLUDED.value
      "#,
    )
    .bind(&minutes)
    .bind(&categories)
    .bind(&metric_names)
    .bind(&labels_col)
    .bind(&values)
    .execute(&self.pool)
    .await
    .map_err(map_db_err)?;

    trace!(processed = result.rows_affected(), "metrics batch upserted");
    Ok(result.rows_affected())
  }

  #[instrument(skip(self))]
  async fn rollup_day(&self, day: NaiveDate) -> MetricsStoreResult<u64> {
    // Recompute from raw rows so repeated calls produce identical output
    // (INV-MET-04).  `count` counts contributing minute-buckets, not events;
    // `sum` aggregates the per-minute deltas into a daily total.
    let result = sqlx::query(
      r#"
      INSERT INTO metrics_daily (day, category, metric_name, labels, sum, count)
      SELECT
        $1::date AS day,
        category,
        metric_name,
        labels,
        SUM(value) AS sum,
        COUNT(*) AS count
      FROM metrics_raw
      WHERE minute >= $1::date::timestamptz
        AND minute <  ($1::date + INTERVAL '1 day')::timestamptz
      GROUP BY category, metric_name, labels
      ON CONFLICT (day, category, metric_name, labels)
      DO UPDATE SET sum = EXCLUDED.sum, count = EXCLUDED.count
      "#,
    )
    .bind(day)
    .execute(&self.pool)
    .await
    .map_err(map_db_err)?;

    trace!(day = %day, rolled_up = result.rows_affected(), "metrics daily rollup");
    Ok(result.rows_affected())
  }

  #[instrument(skip(self))]
  async fn prune_raw_before(&self, cutoff: DateTime<Utc>) -> MetricsStoreResult<u64> {
    let result = sqlx::query("DELETE FROM metrics_raw WHERE minute < $1")
      .bind(cutoff)
      .execute(&self.pool)
      .await
      .map_err(map_db_err)?;
    trace!(cutoff = %cutoff, pruned = result.rows_affected(), "metrics_raw pruned");
    Ok(result.rows_affected())
  }

  #[instrument(skip(self))]
  async fn prune_daily_before(&self, cutoff: NaiveDate) -> MetricsStoreResult<u64> {
    let result = sqlx::query("DELETE FROM metrics_daily WHERE day < $1")
      .bind(cutoff)
      .execute(&self.pool)
      .await
      .map_err(map_db_err)?;
    trace!(cutoff = %cutoff, pruned = result.rows_affected(), "metrics_daily pruned");
    Ok(result.rows_affected())
  }

  async fn count_recent(&self, since: DateTime<Utc>) -> MetricsStoreResult<u64> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM metrics_raw WHERE minute >= $1")
      .bind(since)
      .fetch_one(&self.pool)
      .await
      .map_err(map_db_err)?;
    Ok(count.0.max(0) as u64)
  }

  async fn count_daily_since(&self, since: NaiveDate) -> MetricsStoreResult<u64> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM metrics_daily WHERE day >= $1")
      .bind(since)
      .fetch_one(&self.pool)
      .await
      .map_err(map_db_err)?;
    Ok(count.0.max(0) as u64)
  }

  async fn cache_tuning_snapshot(&self, cache_name: &str) -> MetricsStoreResult<CacheTuningSnapshot> {
    let hit_rate_1h = sqlx::query_scalar(
      "SELECT AVG(hit_rate) FROM cache_tuning_metrics WHERE cache_name = $1 AND measured_at > NOW() - INTERVAL '1 hour' AND cycle_type = 'hourly'",
    )
    .bind(cache_name)
    .fetch_one(&self.pool)
    .await
    .map_err(map_db_err)?;
    let hit_rate_24h = sqlx::query_scalar(
      "SELECT AVG(hit_rate) FROM cache_tuning_metrics WHERE cache_name = $1 AND measured_at > NOW() - INTERVAL '24 hours' AND cycle_type = 'hourly'",
    )
    .bind(cache_name)
    .fetch_one(&self.pool)
    .await
    .map_err(map_db_err)?;
    let latest = sqlx::query_as(
      "SELECT action_taken, measured_at FROM cache_tuning_metrics WHERE cache_name = $1 ORDER BY measured_at DESC LIMIT 1",
    )
    .bind(cache_name)
    .fetch_optional(&self.pool)
    .await
    .map_err(map_db_err)?;
    let (last_action, last_action_at) = latest.unzip();
    Ok(CacheTuningSnapshot {
      hit_rate_1h,
      hit_rate_24h,
      last_action,
      last_action_at,
    })
  }

  async fn cache_tuning_history(
    &self,
    cache_name: &str,
    hours: i64,
  ) -> MetricsStoreResult<Vec<CacheTuningHistorySample>> {
    let rows = sqlx::query_as::<_, (DateTime<Utc>, f64, i32)>(
      r#"
      SELECT
        date_trunc('hour', measured_at),
        AVG(hit_rate),
        MAX(recommended_ttl_seconds)
      FROM cache_tuning_metrics
      WHERE cache_name = $1
        AND measured_at > NOW() - make_interval(hours => $2::int)
        AND cycle_type = 'hourly'
      GROUP BY date_trunc('hour', measured_at)
      ORDER BY date_trunc('hour', measured_at) ASC
      "#,
    )
    .bind(cache_name)
    .bind(i32::try_from(hours).unwrap_or(i32::MAX))
    .fetch_all(&self.pool)
    .await
    .map_err(map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|(bucket, hit_rate, ttl_seconds)| CacheTuningHistorySample {
          bucket,
          hit_rate,
          ttl_seconds,
        })
        .collect(),
    )
  }

  async fn record_cache_tuning(&self, record: &CacheTuningRecord) -> MetricsStoreResult<()> {
    sqlx::query(
      r#"INSERT INTO cache_tuning_metrics
          (cache_name, hits, misses, hit_rate, invalidations_local, invalidations_remote,
           current_ttl_seconds, recommended_ttl_seconds, action_taken, cycle_type, measured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)"#,
    )
    .bind(&record.cache_name)
    .bind(record.hits)
    .bind(record.misses)
    .bind(record.hit_rate)
    .bind(record.invalidations_local)
    .bind(record.invalidations_remote)
    .bind(record.current_ttl_seconds)
    .bind(record.recommended_ttl_seconds)
    .bind(&record.action_taken)
    .bind(&record.cycle_type)
    .bind(record.measured_at)
    .execute(&self.pool)
    .await
    .map_err(map_db_err)?;
    Ok(())
  }

  async fn cache_tuning_is_oscillating(&self, cache_name: &str) -> MetricsStoreResult<bool> {
    let (increases, decreases): (i64, i64) = sqlx::query_as(
      r#"SELECT
           COUNT(*) FILTER (WHERE action_taken = 'increased'),
           COUNT(*) FILTER (WHERE action_taken = 'decreased')
         FROM cache_tuning_metrics
         WHERE cache_name = $1
           AND cycle_type = 'hourly'
           AND measured_at > NOW() - INTERVAL '6 hours'"#,
    )
    .bind(cache_name)
    .fetch_one(&self.pool)
    .await
    .map_err(map_db_err)?;
    Ok(increases > 0 && decreases > 0)
  }

  async fn cache_tuning_ttl_around_24h(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    sqlx::query_scalar(
      r#"SELECT current_ttl_seconds
         FROM cache_tuning_metrics
         WHERE cache_name = $1
           AND measured_at BETWEEN NOW() - INTERVAL '25 hours' AND NOW() - INTERVAL '23 hours'
         ORDER BY measured_at DESC
         LIMIT 1"#,
    )
    .bind(cache_name)
    .fetch_optional(&self.pool)
    .await
    .map_err(map_db_err)
  }

  async fn prune_cache_tuning_history(&self) -> MetricsStoreResult<(u64, u64)> {
    let mut transaction = self.pool.begin().await.map_err(map_db_err)?;
    let hourly = sqlx::query(
      "DELETE FROM cache_tuning_metrics WHERE cycle_type = 'hourly' AND measured_at < NOW() - INTERVAL '7 days'",
    )
    .execute(&mut *transaction)
    .await
    .map_err(map_db_err)?
    .rows_affected();
    let daily = sqlx::query(
      "DELETE FROM cache_tuning_metrics WHERE cycle_type = 'daily' AND measured_at < NOW() - INTERVAL '90 days'",
    )
    .execute(&mut *transaction)
    .await
    .map_err(map_db_err)?
    .rows_affected();
    transaction.commit().await.map_err(map_db_err)?;
    Ok((hourly, daily))
  }

  async fn latest_daily_cache_ttl(&self, cache_name: &str) -> MetricsStoreResult<Option<i32>> {
    sqlx::query_scalar(
      r#"SELECT recommended_ttl_seconds
         FROM cache_tuning_metrics
         WHERE cache_name = $1
           AND cycle_type = 'daily'
           AND measured_at > NOW() - INTERVAL '48 hours'
         ORDER BY measured_at DESC
         LIMIT 1"#,
    )
    .bind(cache_name)
    .fetch_optional(&self.pool)
    .await
    .map_err(map_db_err)
  }
}
