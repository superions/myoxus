// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persistence + dedupe adapters for the telemetry ingest pipeline.
//!
//! * [`SqlxTelemetryRepository`] — Postgres-backed writer for
//!   `telemetry_events`. Bulk-inserts using `UNNEST` so a single round-trip
//!   persists a whole flush batch (hot-path).  Conflicts on `event_id` are
//!   silently skipped to keep the flush idempotent under retry.
//! * [`RedisTelemetryDedupeStore`] — `SETNX EX` on
//!   `telemetry:dedupe:<event_id>` to reject replays (INV-TEL-01).
//!
//! Both adapters layer on top of existing infrastructure primitives
//! (`PgPool`, [`RedisPort`]) so tests can run against
//! [`InMemoryRedisAdapter`] without a real Redis.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use tracing::{error, instrument, trace};

use myoxus_application::ports::RedisPort;
use myoxus_domain::telemetry::{
  TelemetryDedupeStore, TelemetryEventRecord, TelemetryRepository, TelemetryStoreError, TelemetryStoreResult,
};

const DEDUPE_PREFIX: &str = "telemetry:dedupe:";

fn map_db_err(err: sqlx::Error) -> TelemetryStoreError {
  error!(error = %err, "database error in telemetry repository");
  TelemetryStoreError::Backend(err.to_string())
}

/// Postgres-backed [`TelemetryRepository`].
///
/// `insert_batch` bulk-inserts using `UNNEST` arrays — a single prepared
/// statement handles an entire flush regardless of batch size.  The
/// `ON CONFLICT (event_id) DO NOTHING` clause makes the flush safe to retry
/// (e.g. after a transient Postgres error): any rows already persisted in a
/// previous attempt are skipped silently.
pub struct SqlxTelemetryRepository {
  pool: PgPool,
}

impl SqlxTelemetryRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

const LOCK_ID_ROLLUP: i64 = 0x7E1E_717E_0000_0001u64 as i64;
const LOCK_ID_RETENTION: i64 = 0x7E1E_717E_0000_0002u64 as i64;

#[async_trait]
impl TelemetryRepository for SqlxTelemetryRepository {
  #[instrument(skip(self, events), fields(batch_size = events.len()))]
  async fn insert_batch(&self, events: &[TelemetryEventRecord]) -> TelemetryStoreResult<u64> {
    if events.is_empty() {
      return Ok(0);
    }

    // Columnar unpack for UNNEST.
    let len = events.len();
    let mut event_ids: Vec<String> = Vec::with_capacity(len);
    let mut event_names: Vec<String> = Vec::with_capacity(len);
    let mut categories: Vec<String> = Vec::with_capacity(len);
    let mut user_ids: Vec<Option<uuid::Uuid>> = Vec::with_capacity(len);
    let mut client_ids: Vec<Option<String>> = Vec::with_capacity(len);
    let mut session_ids: Vec<Option<String>> = Vec::with_capacity(len);
    let mut schema_versions: Vec<i16> = Vec::with_capacity(len);
    let mut params_col: Vec<Value> = Vec::with_capacity(len);
    let mut user_props_col: Vec<Value> = Vec::with_capacity(len);
    let mut contexts_col: Vec<Value> = Vec::with_capacity(len);
    let mut client_ts_col: Vec<DateTime<Utc>> = Vec::with_capacity(len);

    for ev in events {
      event_ids.push(ev.event_id.clone());
      event_names.push(ev.event_name.clone());
      categories.push(ev.category.clone());
      user_ids.push(ev.user_id);
      client_ids.push(ev.client_id.clone());
      session_ids.push(ev.session_id.clone());
      schema_versions.push(ev.schema_version);
      params_col.push(ev.params.clone());
      user_props_col.push(ev.user_properties.clone());
      contexts_col.push(ev.context.clone());
      client_ts_col.push(ev.client_timestamp);
    }

    let result = sqlx::query(
      r#"
      INSERT INTO telemetry_events
        (event_id, event_name, category, user_id, client_id, session_id,
         schema_version, params, user_properties, context, client_timestamp)
      SELECT * FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::uuid[],
        $5::text[],
        $6::text[],
        $7::smallint[],
        $8::jsonb[],
        $9::jsonb[],
        $10::jsonb[],
        $11::timestamptz[]
      )
      ON CONFLICT (event_id) DO NOTHING
      "#,
    )
    .bind(&event_ids)
    .bind(&event_names)
    .bind(&categories)
    .bind(&user_ids)
    .bind(&client_ids)
    .bind(&session_ids)
    .bind(&schema_versions)
    .bind(&params_col)
    .bind(&user_props_col)
    .bind(&contexts_col)
    .bind(&client_ts_col)
    .execute(&self.pool)
    .await
    .map_err(map_db_err)?;

    trace!(inserted = result.rows_affected(), "telemetry batch inserted");
    Ok(result.rows_affected())
  }

  async fn count_recent(&self, since: DateTime<Utc>) -> TelemetryStoreResult<u64> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM telemetry_events WHERE received_at >= $1")
      .bind(since)
      .fetch_one(&self.pool)
      .await
      .map_err(map_db_err)?;
    Ok(count.0.max(0) as u64)
  }

  async fn count_daily_rollups_since(&self, since: chrono::NaiveDate) -> TelemetryStoreResult<u64> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM telemetry_daily WHERE day >= $1")
      .bind(since)
      .fetch_one(&self.pool)
      .await
      .map_err(map_db_err)?;
    Ok(count.0.max(0) as u64)
  }

  async fn rollup_previous_day(&self) -> TelemetryStoreResult<Option<u64>> {
    let mut transaction = self.pool.begin().await.map_err(map_db_err)?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
      .bind(LOCK_ID_ROLLUP)
      .fetch_one(&mut *transaction)
      .await
      .map_err(map_db_err)?;
    if !acquired {
      transaction.rollback().await.map_err(map_db_err)?;
      return Ok(None);
    }
    let rows = sqlx::query(
      r#"
      INSERT INTO telemetry_daily (day, category, event_name, count, unique_users, unique_sessions)
      SELECT (received_at AT TIME ZONE 'UTC')::date, category, event_name,
             COUNT(*)::bigint, COUNT(DISTINCT user_id)::bigint, COUNT(DISTINCT session_id)::bigint
      FROM telemetry_events
      WHERE received_at >= (CURRENT_DATE - INTERVAL '1 day') AT TIME ZONE 'UTC'
        AND received_at < CURRENT_DATE AT TIME ZONE 'UTC'
      GROUP BY 1, 2, 3
      ON CONFLICT (day, category, event_name) DO UPDATE SET
        count = EXCLUDED.count,
        unique_users = EXCLUDED.unique_users,
        unique_sessions = EXCLUDED.unique_sessions
      "#,
    )
    .execute(&mut *transaction)
    .await
    .map_err(map_db_err)?
    .rows_affected();
    transaction.commit().await.map_err(map_db_err)?;
    Ok(Some(rows))
  }

  async fn apply_retention(&self, raw_days: u32, daily_days: u32) -> TelemetryStoreResult<Option<(u64, u64)>> {
    let mut transaction = self.pool.begin().await.map_err(map_db_err)?;
    let acquired = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock($1)")
      .bind(LOCK_ID_RETENTION)
      .fetch_one(&mut *transaction)
      .await
      .map_err(map_db_err)?;
    if !acquired {
      transaction.rollback().await.map_err(map_db_err)?;
      return Ok(None);
    }
    let raw = sqlx::query("DELETE FROM telemetry_events WHERE received_at < NOW() - make_interval(days => $1)")
      .bind(i32::try_from(raw_days).unwrap_or(i32::MAX))
      .execute(&mut *transaction)
      .await
      .map_err(map_db_err)?
      .rows_affected();
    let daily = sqlx::query("DELETE FROM telemetry_daily WHERE day < CURRENT_DATE - $1")
      .bind(i32::try_from(daily_days).unwrap_or(i32::MAX))
      .execute(&mut *transaction)
      .await
      .map_err(map_db_err)?
      .rows_affected();
    transaction.commit().await.map_err(map_db_err)?;
    Ok(Some((raw, daily)))
  }
}

/// Redis-backed [`TelemetryDedupeStore`] using `SET NX EX`.
pub struct RedisTelemetryDedupeStore {
  redis: Arc<dyn RedisPort>,
}

impl RedisTelemetryDedupeStore {
  pub fn new(redis: Arc<dyn RedisPort>) -> Self {
    Self { redis }
  }
}

#[async_trait]
impl TelemetryDedupeStore for RedisTelemetryDedupeStore {
  #[instrument(skip(self, event_id))]
  async fn try_register(&self, event_id: &str, ttl_seconds: u64) -> TelemetryStoreResult<bool> {
    let redis_key = format!("{DEDUPE_PREFIX}{event_id}");
    self
      .redis
      .setnx_string(&redis_key, "1", Some(ttl_seconds))
      .await
      .map_err(|e| TelemetryStoreError::Backend(format!("setnx failed: {e}")))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::redis::InMemoryRedisAdapter;

  #[tokio::test]
  async fn dedupe_first_seen_then_replay() {
    let redis: Arc<dyn RedisPort> = Arc::new(InMemoryRedisAdapter::new("test"));
    let store = RedisTelemetryDedupeStore::new(redis);
    assert!(store.try_register("evt-1", 60).await.unwrap(), "first seen");
    assert!(!store.try_register("evt-1", 60).await.unwrap(), "replay");
    assert!(store.try_register("evt-2", 60).await.unwrap(), "distinct id");
  }
}
