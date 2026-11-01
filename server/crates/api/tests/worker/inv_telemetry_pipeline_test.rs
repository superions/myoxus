// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end invariant tests for the telemetry pipeline (P-Telemetry-G).
//!
//! These tests exercise the full HTTP ingest path:
//! `POST /api/telemetry/collect` → ingest service → hot buffer →
//! `flush_batch()` → `telemetry_events` — and the related rollup/retention
//! jobs.  Each test is named after the invariant it guards (INV-TEL-*) and
//! documented in `docs/dev/server/telemetry.md`.
//!
//! The router is built with a real [`SqlxTelemetryRepository`] so every
//! assertion runs against a Postgres row — not an in-memory stub. Dedupe is
//! done via the in-memory store because the tests do not require a Redis.

use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{
  build_router_for_integration_tests as build_router,
  config::AppConfig,
  state::ApiState,
  telemetry_worker::{TelemetryQueueHandler, flush_on_shutdown},
};
use myoxus_application::telemetry::{
  TelemetryIngestService,
  service::{InMemoryTelemetryDedupe, InMemoryTelemetryRepo},
};
use myoxus_infrastructure::telemetry::SqlxTelemetryRepository;
use myoxus_worker::{Job, JobHandler, JobOptions};

fn test_job(name: &str) -> Job {
  Job {
    id: format!("test-{name}"),
    name: name.to_string(),
    data: json!({}),
    opts: JobOptions::default(),
    timestamp: chrono::Utc::now().timestamp_millis(),
    attempts_made: 0,
    finished_on: None,
    failed_reason: None,
    heartbeat: None,
    return_value: None,
  }
}

/// Build a router + the underlying `TelemetryIngestService` backed by a real
/// Postgres repository.  The in-memory dedupe store keeps the tests
/// self-contained (no test Redis required).
async fn make_app(pool: &PgPool) -> (axum::Router, Arc<TelemetryIngestService>) {
  make_app_with(pool, |_| {}).await
}

/// Same as [`make_app`] but lets the caller tweak the AppConfig before the
/// router is built (e.g. to disable a category or the global master switch).
async fn make_app_with(
  pool: &PgPool,
  mutate: impl FnOnce(&mut AppConfig),
) -> (axum::Router, Arc<TelemetryIngestService>) {
  let mut config = AppConfig::load().expect("config");
  mutate(&mut config);

  let repo: Arc<dyn myoxus_domain::telemetry::TelemetryRepository> =
    Arc::new(SqlxTelemetryRepository::new(pool.clone()));
  let dedupe: Arc<dyn myoxus_domain::telemetry::TelemetryDedupeStore> = Arc::new(InMemoryTelemetryDedupe::default());
  let telemetry = Arc::new(TelemetryIngestService::new(repo, dedupe));

  let state = ApiState::new(config)
    .with_metrics_pool(pool.clone())
    .with_telemetry_service(telemetry.clone());
  (build_router(state), telemetry)
}

fn sample_event(event_id: &str, event_name: &str, category: &str) -> Value {
  json!({
    "eventId": event_id,
    "schemaVersion": 1,
    "eventName": event_name,
    "category": category,
    "params": {"foo": "bar"},
    "userProperties": {},
    "context": {"page": "/editor"},
  })
}

async fn post_collect(app: &axum::Router, body: Value) -> (u16, Value) {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/telemetry/collect")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build request"),
    )
    .await
    .expect("response");
  let status = resp.status().as_u16();
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
  (status, json)
}

async fn post_graphql_anon(app: &axum::Router, query: &str) -> Value {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "query": query }).to_string()))
        .expect("build GraphQL request"),
    )
    .await
    .expect("GraphQL response");
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&bytes).expect("graphql json")
}

async fn row_exists(pool: &PgPool, event_id: &str) -> bool {
  let (c,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE event_id = $1")
    .bind(event_id)
    .fetch_one(pool)
    .await
    .expect("count");
  c > 0
}

async fn cleanup_events(pool: &PgPool, event_ids: &[&str]) {
  for id in event_ids {
    sqlx::query("DELETE FROM telemetry_events WHERE event_id = $1")
      .bind(*id)
      .execute(pool)
      .await
      .ok();
  }
}

// ─── INV-TEL-01 / -05 / happy path ────────────────────────────────────────────

/// INV-TEL-01 — a well-formed event POSTed to `/collect` is accepted, flushed
/// to Postgres, and its `event_id` is unique there.
#[tokio::test]
async fn inv_tel01_ingest_persists_event() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app(&pool).await;

  let event_id = format!("tel01-{}", Uuid::new_v4());
  let (status, ack) = post_collect(
    &app,
    json!({ "events": [sample_event(&event_id, "pageView", "page_view")] }),
  )
  .await;
  assert_eq!(status, 200, "ack={ack}");
  assert_eq!(ack["accepted"], 1);
  assert_eq!(ack["dropped"], 0);

  // Hot buffer holds it until flush.
  assert_eq!(svc.buffer_len().await, 1, "event should be in hot buffer before flush");
  let stats = svc.flush_batch(100).await.expect("flush");
  assert_eq!(stats.inserted, 1);
  assert!(
    row_exists(&pool, &event_id).await,
    "event must land in telemetry_events"
  );

  cleanup_events(&pool, &[&event_id]).await;
}

// ─── INV-TEL-01 dedupe (handler path) ─────────────────────────────────────────

/// INV-TEL-01 — the same `eventId` is accepted exactly once even when retried
/// back-to-back. The second POST reports `dropped=1` without a 5xx.
#[tokio::test]
async fn inv_tel02_dedupe_rejects_duplicate_event_id() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app(&pool).await;

  let event_id = format!("tel02-{}", Uuid::new_v4());
  let (s1, _) = post_collect(
    &app,
    json!({ "events": [sample_event(&event_id, "pageView", "page_view")] }),
  )
  .await;
  let (s2, ack2) = post_collect(
    &app,
    json!({ "events": [sample_event(&event_id, "pageView", "page_view")] }),
  )
  .await;
  assert_eq!(s1, 200);
  assert_eq!(s2, 200);
  assert_eq!(ack2["accepted"], 0, "duplicate must be rejected");
  assert_eq!(ack2["dropped"], 1);

  svc.flush_batch(100).await.expect("flush");
  let (c,): (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM telemetry_events WHERE event_id = $1")
    .bind(&event_id)
    .fetch_one(&pool)
    .await
    .expect("count");
  assert_eq!(c, 1, "exactly one row despite two POSTs");

  cleanup_events(&pool, &[&event_id]).await;
}

// ─── INV-TEL-02 category fail-closed ──────────────────────────────────────────

/// INV-TEL-02 — an event whose `category` is disabled in config is dropped
/// before persistence.  Ack reports `dropped=1`.
#[tokio::test]
async fn inv_tel03_disabled_category_drops_event() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app_with(&pool, |c| {
    c.telemetry.categories.insert("page_view".into(), false);
  })
  .await;

  let event_id = format!("tel03-{}", Uuid::new_v4());
  let (status, ack) = post_collect(
    &app,
    json!({ "events": [sample_event(&event_id, "pageView", "page_view")] }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(ack["accepted"], 0);
  assert_eq!(ack["dropped"], 1);

  assert_eq!(svc.buffer_len().await, 0, "event must not enter hot buffer");
  svc.flush_batch(100).await.expect("flush");
  assert!(
    !row_exists(&pool, &event_id).await,
    "disabled category must not persist"
  );
}

// ─── INV-TEL-03 global switch ─────────────────────────────────────────────────

/// INV-TEL-03 — when `telemetry.enabled=false` the handler answers 503 and no
/// event enters the buffer.
#[tokio::test]
async fn inv_tel04_disabled_global_returns_503() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app_with(&pool, |c| c.telemetry.enabled = false).await;

  let event_id = format!("tel04-{}", Uuid::new_v4());
  let (status, ack) = post_collect(
    &app,
    json!({ "events": [sample_event(&event_id, "pageView", "page_view")] }),
  )
  .await;
  assert_eq!(status, 503, "global disable must return 503");
  assert_eq!(ack["ok"], false);
  assert_eq!(ack["accepted"], 0);
  assert_eq!(ack["dropped"], 1);
  assert_eq!(svc.buffer_len().await, 0);
}

// ─── INV-TEL-07 rollup job ────────────────────────────────────────────────────

/// INV-TEL-07 — the rollup job aggregates yesterday's raw events into
/// `telemetry_daily`.  We insert a past-dated row directly (same shape as the
/// ingest path would have produced) and assert an upsert into `telemetry_daily`.
#[tokio::test]
async fn inv_tel05_rollup_aggregates_daily() {
  let pool = helpers::setup_pool().await;
  let (_app, svc) = make_app(&pool).await;

  // Insert two events dated yesterday in the same category/name.  Use direct
  // SQL because the ingest path stamps received_at=NOW() (rollup filters on
  // yesterday-only).
  let yesterday = Utc::now() - chrono::Duration::days(1);
  let name = format!("tel05_rollup_{}", Uuid::new_v4());
  let ids = [
    format!("tel05a-{}", Uuid::new_v4()),
    format!("tel05b-{}", Uuid::new_v4()),
  ];
  for id in &ids {
    sqlx::query(
      r#"INSERT INTO telemetry_events
         (event_id, event_name, category, schema_version, client_timestamp, received_at)
         VALUES ($1, $2, 'admin_action', 1, $3, $3)"#,
    )
    .bind(id)
    .bind(&name)
    .bind(yesterday)
    .execute(&pool)
    .await
    .expect("seed event");
  }

  // Pre-clean any stale rollup entry (same day+name should be rare, but this
  // test is idempotent).
  let day = yesterday.date_naive();
  sqlx::query("DELETE FROM telemetry_daily WHERE day = $1 AND event_name = $2")
    .bind(day)
    .bind(&name)
    .execute(&pool)
    .await
    .ok();

  let handler = TelemetryQueueHandler {
    service: svc.clone(),
    flush_batch_max: 100,
    retention_raw_days: 30,
    retention_daily_days: 90,
  };
  handler.process(&test_job("telemetry.rollup")).await.expect("rollup");

  let (count,): (i64,) = sqlx::query_as(
    "SELECT count FROM telemetry_daily WHERE day = $1 AND event_name = $2 AND category = 'admin_action'",
  )
  .bind(day)
  .bind(&name)
  .fetch_one(&pool)
  .await
  .expect("rollup row");
  assert_eq!(count, 2, "rollup must aggregate both events");

  // Cleanup.
  sqlx::query("DELETE FROM telemetry_events WHERE event_id = ANY($1)")
    .bind(&ids[..])
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM telemetry_daily WHERE day = $1 AND event_name = $2")
    .bind(day)
    .bind(&name)
    .execute(&pool)
    .await
    .ok();
}

// ─── INV-TEL-08 retention ─────────────────────────────────────────────────────

/// INV-TEL-08 — the retention job prunes raw events older than
/// `retention_raw_days` but leaves younger rows untouched.
#[tokio::test]
async fn inv_tel06_retention_prunes_old_events() {
  let pool = helpers::setup_pool().await;
  let (_app, svc) = make_app(&pool).await;

  let old_id = format!("tel06-old-{}", Uuid::new_v4());
  let fresh_id = format!("tel06-fresh-{}", Uuid::new_v4());

  sqlx::query(
    r#"INSERT INTO telemetry_events
       (event_id, event_name, category, schema_version, client_timestamp, received_at)
       VALUES ($1, 'tel06.retention', 'admin_action', 1, $2, $2)"#,
  )
  .bind(&old_id)
  .bind(Utc::now() - chrono::Duration::days(30))
  .execute(&pool)
  .await
  .expect("seed old");

  sqlx::query(
    r#"INSERT INTO telemetry_events
       (event_id, event_name, category, schema_version, client_timestamp, received_at)
       VALUES ($1, 'tel06.retention', 'admin_action', 1, $2, $2)"#,
  )
  .bind(&fresh_id)
  .bind(Utc::now() - chrono::Duration::days(1))
  .execute(&pool)
  .await
  .expect("seed fresh");

  let handler = TelemetryQueueHandler {
    service: svc.clone(),
    flush_batch_max: 100,
    retention_raw_days: 14,
    retention_daily_days: 90,
  };
  handler
    .process(&test_job("telemetry.retention"))
    .await
    .expect("retention");

  assert!(!row_exists(&pool, &old_id).await, "30d-old row must be pruned");
  assert!(row_exists(&pool, &fresh_id).await, "1d-old row must survive");

  cleanup_events(&pool, &[&fresh_id]).await;
}

// ─── INV-TEL-04 PII strip (DB-level verification) ─────────────────────────────

/// INV-TEL-04 — even when the client smuggles `ip`/`email` into context and
/// user_properties, the persisted JSONB carries no trace of it.
#[tokio::test]
async fn inv_tel07_ip_not_stored_in_db() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app(&pool).await;

  let event_id = format!("tel07-{}", Uuid::new_v4());
  let body = json!({ "events": [{
    "eventId": event_id,
    "schemaVersion": 1,
    "eventName": "pageView",
    "category": "page_view",
    "params": {"page": "/editor"},
    "userProperties": {"email": "leak@example.com", "locale": "de-DE"},
    "context": {"ip": "10.0.0.1", "userAgent": "Mozilla/5.0"},
  }]});
  let (status, ack) = post_collect(&app, body).await;
  assert_eq!(status, 200, "{ack}");
  assert_eq!(ack["accepted"], 1);

  svc.flush_batch(100).await.expect("flush");

  let (context, user_properties): (Value, Value) =
    sqlx::query_as("SELECT context, user_properties FROM telemetry_events WHERE event_id = $1")
      .bind(&event_id)
      .fetch_one(&pool)
      .await
      .expect("row");

  assert!(context.get("ip").is_none(), "ip must be stripped from context");
  assert!(
    user_properties.get("email").is_none(),
    "email must be stripped from user_properties"
  );
  assert_eq!(
    context.get("userAgent").and_then(Value::as_str),
    Some("Mozilla/5.0"),
    "non-PII context keys are preserved"
  );
  assert_eq!(
    user_properties.get("locale").and_then(Value::as_str),
    Some("de-DE"),
    "non-PII user_properties keys are preserved"
  );

  // Raw row scan: the full JSONB should not serialize to any PII substring.
  let (raw_row,): (String,) = sqlx::query_as(
    "SELECT context::text || '|' || user_properties::text || '|' || params::text
     FROM telemetry_events WHERE event_id = $1",
  )
  .bind(&event_id)
  .fetch_one(&pool)
  .await
  .expect("raw row");
  assert!(!raw_row.contains("10.0.0.1"), "IP literal must not be persisted");
  assert!(
    !raw_row.contains("leak@example.com"),
    "email literal must not be persisted"
  );

  cleanup_events(&pool, &[&event_id]).await;
}

// ─── INV-TEL-06 graceful shutdown flush ───────────────────────────────────────

/// INV-TEL-06 — on graceful shutdown the final flush drains the hot buffer
/// into Postgres so no queued event is lost.
#[tokio::test]
async fn inv_tel11_graceful_shutdown_flushes_buffer() {
  let pool = helpers::setup_pool().await;
  let (app, svc) = make_app(&pool).await;

  // Enqueue three events without invoking the scheduled flush.
  let mut ids = Vec::with_capacity(3);
  let mut events = Vec::with_capacity(3);
  for _ in 0..3 {
    let id = format!("tel11-{}", Uuid::new_v4());
    events.push(sample_event(&id, "pageView", "page_view"));
    ids.push(id);
  }
  let (status, ack) = post_collect(&app, json!({ "events": events })).await;
  assert_eq!(status, 200, "{ack}");
  assert_eq!(ack["accepted"], 3);
  assert_eq!(svc.buffer_len().await, 3, "events buffered awaiting flush");

  // Simulate the shutdown handler in crates/api/src/bin/server.rs.
  flush_on_shutdown(&svc, 500).await;

  assert_eq!(svc.buffer_len().await, 0, "shutdown must drain the hot buffer");
  for id in &ids {
    assert!(row_exists(&pool, id).await, "{id} must be persisted by shutdown flush");
  }

  let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
  cleanup_events(&pool, &id_refs).await;
}

// ─── INV-TEL-04 admin GraphQL status (P-Telemetry-E) ─────────────────────────

/// INV-TEL-04 — `admin { telemetryStatus }` MUST reject unauthenticated callers
/// so the runtime policy, counters and 24 h persisted count are never leaked to
/// anonymous clients.
#[test]
fn inv_tel12_admin_status_requires_admin() {
  helpers::block_on_large_stack("inv-tel12-admin-status", || async {
    let config = AppConfig::load().expect("config");
    let state = ApiState::new(config);
    let app = build_router(state);
    let response = post_graphql_anon(
      &app,
      "{ admin { telemetryStatus { enabled hotBufferLen persisted24h } } }",
    )
    .await;
    assert!(
      response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
      "admin telemetry status must require authentication: {response}"
    );
  });
}

/// INV-TEL-04 — `admin { flushTelemetry }` MUST reject unauthenticated callers.
/// Flushing is operator-only; exposing it anonymously would let attackers
/// manipulate the admin dashboard view.
#[test]
fn inv_tel14_admin_flush_requires_admin() {
  helpers::block_on_large_stack("inv-tel14-admin-flush", || async {
    let config = AppConfig::load().expect("config");
    let state = ApiState::new(config);
    let app = build_router(state);
    let response = post_graphql_anon(&app, "mutation { admin { flushTelemetry { buffered inserted } } }").await;
    assert!(
      response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
      "admin telemetry flush must require authentication: {response}"
    );
  });
}

/// INV-TEL-04 — the admin-facing status response MUST NOT carry any per-user
/// or per-IP data.  We assert this on the serialized JSON shape of the typed
/// response so a future contributor who adds a `user_id` or `email` field to
/// the struct gets a red test here, not a silent PII leak in production.
#[tokio::test]
async fn inv_tel13_admin_status_no_pii() {
  use myoxus_api::admin_runtime_status::{AdminTelemetryCounters, AdminTelemetryStatusResponse};
  use std::collections::BTreeMap;

  let sample = AdminTelemetryStatusResponse {
    enabled: true,
    categories: BTreeMap::from([("page_view".to_string(), true)]),
    sampling_rates: BTreeMap::from([("page_view".to_string(), 1.0)]),
    retention_raw_days: 14,
    retention_daily_days: 90,
    flush_interval_seconds: 60,
    batch_max_events: 500,
    dedupe_ttl_hours: 1,
    ingest_rate_limit_per_ip_per_min: 600,
    counters: AdminTelemetryCounters {
      offered_total: 0,
      accepted_total: 0,
      rejected_disabled_total: 0,
      rejected_category_total: 0,
      rejected_sampled_total: 0,
      rejected_duplicate_total: 0,
      rejected_invalid_total: 0,
      buffer_overflow_total: 0,
      flushed_total: 0,
    },
    hot_buffer_len: 0,
    persisted_24h: Some(0),
    daily_rollups_7d: Some(0),
    last_flush_at: None,
    last_flush_count: 0,
    dedupe_hit_rate: 0.0,
  };
  let value = serde_json::to_value(&sample).expect("serialize");
  let forbidden: &[&str] = &[
    "user_id",
    "userId",
    "email",
    "ip",
    "ip_address",
    "ipAddress",
    "client_id",
    "clientId",
    "session_id",
    "sessionId",
    "remote_addr",
    "remoteAddr",
  ];
  fn walk_keys(v: &Value, seen: &mut Vec<String>) {
    match v {
      Value::Object(map) => {
        for (k, sub) in map {
          seen.push(k.clone());
          walk_keys(sub, seen);
        }
      }
      Value::Array(items) => items.iter().for_each(|x| walk_keys(x, seen)),
      _ => {}
    }
  }
  let mut keys = Vec::new();
  walk_keys(&value, &mut keys);
  for bad in forbidden {
    assert!(
      !keys.iter().any(|k| k == bad),
      "admin telemetry status must not expose `{bad}` — keys seen: {keys:?}"
    );
  }
}

// ─── HTTP request-budget invariants ───────────────────────────────────────────
//
// inv_tel10 (Socket.IO handler) is covered by the Socket.IO test suite.

fn rate_limit_state(enabled: bool) -> ApiState {
  let mut config = AppConfig::load().expect("config");
  config.telemetry.enabled = enabled;
  config.telemetry.ingest_rate_limit_per_ip_per_min = 1;
  config.throttle.enabled = true;
  config.throttle.throttlers.default.limit = 1;
  config.throttle.throttlers.strict.limit = 1;
  config.captcha.enabled = false;
  ApiState::new(config)
}

async fn collect_response(
  app: &axum::Router,
  peer: &str,
  forwarded: &str,
  cookie: &str,
  body: Value,
) -> axum::response::Response {
  app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/telemetry/collect")
        .header("content-type", "application/json")
        .header("x-forwarded-for", forwarded)
        .header("cookie", cookie)
        .extension(axum::extract::ConnectInfo(
          peer.parse::<std::net::SocketAddr>().expect("peer"),
        ))
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response")
}

/// The real HTTP router shares a Redis IP budget across anonymous and signed-in
/// clients/replicas, ignores spoofed headers from direct peers, and never queues
/// rejected batches. Other public/auth budgets stay independent.
#[tokio::test]
async fn inv_tel09_rate_limit_blocks_flood() {
  use myoxus_application::{auth::SessionContext, ports::RedisPort};
  use myoxus_infrastructure::redis::RedisAdapter;

  let redis = Arc::new(
    RedisAdapter::new(
      std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6380".into()),
      format!("tel09-{}", Uuid::new_v4()),
    )
    .expect("test redis"),
  );
  let state = rate_limit_state(true).with_redis_port(redis.clone());
  let user = state
    .auth()
    .store
    .fulfill_user("tel09@example.test", Some("Telemetry test"), None)
    .await
    .expect("user");
  let session = state
    .auth()
    .create_user_session(
      user.id,
      SessionContext {
        user_agent: None,
        ip_address: None,
      },
    )
    .await
    .expect("session");
  assert!(
    state
      .auth()
      .get_session_snapshot(session.id)
      .await
      .expect("snapshot")
      .is_some()
  );
  let cookie = format!("affine_session={}", session.id);
  let svc = state.telemetry_arc();
  let app = build_router(state);
  // A replica with the general throttle disabled must still enforce this budget.
  let mut replica_config = rate_limit_state(true).config;
  replica_config.throttle.enabled = false;
  let replica_state = ApiState::new(replica_config).with_redis_port(redis.clone());
  let replica_svc = replica_state.telemetry_arc();
  let replica = build_router(replica_state);
  let batch = || {
    json!({"events": [
      sample_event(&Uuid::new_v4().to_string(), "pageView", "page_view"),
      sample_event(&Uuid::new_v4().to_string(), "pageView", "page_view"),
    ]})
  };

  // Keep the flood assertion inside one production minute window.
  let remaining_ms = 60_000 - Utc::now().timestamp_millis().rem_euclid(60_000);
  if remaining_ms < 5_000 {
    tokio::time::sleep(std::time::Duration::from_millis(remaining_ms as u64 + 10)).await;
  }
  let accepted = collect_response(&app, "198.51.100.42:4000", "203.0.113.1", "", batch()).await;
  assert_eq!(accepted.status(), 200);
  let ack: Value =
    serde_json::from_slice(&accepted.into_body().collect().await.expect("body").to_bytes()).expect("ack");
  assert_eq!(ack["accepted"], 2, "one request can accept a batch");
  assert_eq!(svc.buffer_len().await, 2);
  let rejected = collect_response(&app, "198.51.100.42:4001", "203.0.113.2", &cookie, batch()).await;
  assert_eq!(
    rejected.status(),
    429,
    "session and spoofed header cannot bypass IP limit"
  );
  let retry: u64 = rejected.headers()["retry-after"]
    .to_str()
    .expect("header")
    .parse()
    .expect("seconds");
  assert!((1..=60).contains(&retry));
  assert_eq!(rejected.headers()["x-ratelimit-limit"], "1");
  assert_eq!(rejected.headers()["x-ratelimit-remaining"], "0");
  let error: Value =
    serde_json::from_slice(&rejected.into_body().collect().await.expect("body").to_bytes()).expect("error");
  assert_eq!(error["error"], "too_many_requests");
  assert_eq!(svc.buffer_len().await, 2, "rejected batch cannot enqueue");
  let rejected = collect_response(&replica, "198.51.100.42:4002", "203.0.113.3", "", batch()).await;
  assert_eq!(
    rejected.status(),
    429,
    "budget is shared even with throttle.enabled=false"
  );
  assert_eq!(replica_svc.buffer_len().await, 0);
  let independent = collect_response(&replica, "198.51.100.43:4000", "203.0.113.1", "", batch()).await;
  assert_eq!(independent.status(), 200, "different IP has its own budget");

  for (path, first_status) in [("/api/telemetry/status", 200), ("/api/auth/challenge", 503)] {
    for expected in [first_status, 429] {
      let response = app
        .clone()
        .oneshot(
          Request::builder()
            .uri(path)
            .extension(axum::extract::ConnectInfo(
              "198.51.100.42:4000".parse::<std::net::SocketAddr>().expect("peer"),
            ))
            .body(Body::empty())
            .expect("request"),
        )
        .await
        .expect("response");
      assert_eq!(response.status().as_u16(), expected, "existing route budget for {path}");
    }
  }

  let mut connection = redis.command_connection().await.expect("connection");
  let keys: Vec<String> = redis::cmd("KEYS")
    .arg(format!("{}:throttler:*telemetry-collect*", redis.namespace()))
    .query_async(&mut connection)
    .await
    .expect("keys");
  assert_eq!(keys.len(), 2, "two IP budgets");
  for key in keys {
    assert!(!key.contains("198.51.100."), "raw IP must not enter Redis keys");
    let ttl: i64 = redis::cmd("TTL")
      .arg(&key)
      .query_async(&mut connection)
      .await
      .expect("ttl");
    assert!((1..=60).contains(&ttl), "counter must expire: {ttl}");
  }
  redis.delete_by_pattern("*").await.expect("clean test namespace");
}

/// Missing peer/proxy information cannot turn IP-shaped User-Agent values
/// into independent budgets. Both callers share the unknown-IP bucket.
#[tokio::test]
async fn inv_tel09_user_agent_cannot_create_ip_budget() {
  let state = rate_limit_state(true);
  let svc = state.telemetry_arc();
  let app = build_router(state);
  let remaining_ms = 60_000 - Utc::now().timestamp_millis().rem_euclid(60_000);
  if remaining_ms < 5_000 {
    tokio::time::sleep(std::time::Duration::from_millis(remaining_ms as u64 + 10)).await;
  }
  for (agent, expected) in [("198.51.100.1", 200), ("198.51.100.2", 429)] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/api/telemetry/collect")
          .header("content-type", "application/json")
          .header("user-agent", agent)
          .body(Body::from(
            json!({"events": [sample_event(&Uuid::new_v4().to_string(), "pageView", "page_view")]}).to_string(),
          ))
          .expect("request"),
      )
      .await
      .expect("response");
    assert_eq!(
      response.status().as_u16(),
      expected,
      "User-Agent must not identify an IP"
    );
  }
  assert_eq!(svc.buffer_len().await, 1, "only the first batch can enqueue");
}

#[tokio::test]
async fn inv_tel09_redis_failures_do_not_ingest() {
  use myoxus_application::ports::{PortError, PortResult, RedisPort};
  struct FailingRedis {
    counter_fails: bool,
  }
  #[async_trait::async_trait]
  impl RedisPort for FailingRedis {
    async fn get_string(&self, _: &str) -> PortResult<Option<String>> {
      Ok(None)
    }
    async fn set_string(&self, _: &str, _: &str, _: Option<u64>) -> PortResult<()> {
      Ok(())
    }
    async fn delete_key(&self, _: &str) -> PortResult<()> {
      Ok(())
    }
    async fn increase(&self, _: &str, _: i64) -> PortResult<i64> {
      if self.counter_fails {
        Err(PortError::Transport("unavailable".into()))
      } else {
        Ok(1)
      }
    }
  }
  for counter_fails in [true, false] {
    let state = rate_limit_state(true).with_redis_port(Arc::new(FailingRedis { counter_fails }));
    let svc = state.telemetry_arc();
    let app = build_router(state);
    let (status, body) = post_collect(
      &app,
      json!({"events": [sample_event("unavailable", "pageView", "page_view")]}),
    )
    .await;
    assert_eq!(status, 503);
    assert_eq!(body["error"], "telemetry_throttle_unavailable");
    assert_eq!(svc.buffer_len().await, 0);
  }
}

/// Sanity: the in-memory repository + dedupe pair used by the unit-test suite
/// agrees with the Postgres path on a single event.  This isolates
/// ingest-service logic from SQL failures when debugging regressions.
#[tokio::test]
async fn inv_tel_ingest_service_smoke_in_memory() {
  let repo = Arc::new(InMemoryTelemetryRepo::default());
  let dedupe = Arc::new(InMemoryTelemetryDedupe::default());
  let svc = TelemetryIngestService::new(repo.clone(), dedupe);

  let config = AppConfig::load().expect("config");
  let policy = myoxus_application::telemetry::TelemetryPolicy {
    enabled: true,
    categories: config.telemetry.categories.clone(),
    sampling_rates: config.telemetry.sampling_rates.clone(),
    dedupe_ttl_hours: 1,
    dedupe_max_entries: 100,
    batch_max_events: 100,
  };

  let ev = myoxus_application::telemetry::TelemetryEvent {
    event_id: "mem-1".into(),
    schema_version: 1,
    event_name: "pageView".into(),
    category: Some("page_view".into()),
    params: Value::Null,
    user_properties: Value::Null,
    context: json!({"ip": "1.2.3.4"}),
    user_id: None,
    client_id: None,
    session_id: None,
    timestamp_micros: None,
    opt_out: false,
  };
  svc.ingest(ev, &policy).await.expect("accept");
  svc.flush_batch(100).await.expect("flush");
  let rows = repo.snapshot();
  assert_eq!(rows.len(), 1);
  assert!(rows[0].context.get("ip").is_none(), "ip stripped");
}
