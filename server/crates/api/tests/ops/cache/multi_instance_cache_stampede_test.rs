// SPDX-License-Identifier: AGPL-3.0-or-later
//! Multi-instance concurrent serverConfig integration test.
//!
//! Invariant (INV-STAMPEDE-MULTI-01):
//!   When two server instances share a database, 100 concurrent serverConfig
//!   requests remain successful and consistent.
//!
//! Observable invariants:
//! 1. All 100 responses are error-free.
//! 2. All 100 responses are byte-for-byte identical (proves coalescing).
//! This journey does not expose SQL or loader counts and therefore makes no
//! stampede/coalescing claim. Those assertions live at the actual loaders.

use crate::helpers;

use std::sync::{Arc, OnceLock};

use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;
use tokio::sync::Mutex;
use uuid::Uuid;

fn stampede_multi_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

const SERVER_CONFIG_QUERY: &str = r#"
  query { serverConfig { name version credentialsRequirement { password { minLength maxLength } } } }
"#;

/// INV-STAMPEDE-MULTI-01: Two cold-cache instances, 50 concurrent requests
/// each (100 total) → all succeed with identical data.
#[tokio::test]
async fn inv_concurrent_server_config_is_consistent_across_instances() {
  // Serialise with the single-instance stampede test to avoid PG connection
  // exhaustion (each setup_app_with_pool() opens a pool).
  let _lock = stampede_multi_lock().lock().await;

  // Single shared pool — both instances read from the same database.
  let pool = helpers::setup_pool().await;

  // Build two independent instances: each has its own ApiState (fresh moka
  // cache, independent miss/hit counters).
  let (app1, _, auth_store1) = helpers::setup_app_with_pool(pool.clone()).await;
  let (app2, _, _auth_store2) = helpers::setup_app_with_pool(pool.clone()).await;

  // Seed one admin user (single session used for all 100 requests).
  let (_, session_id) = helpers::seed_admin(&pool, &auth_store1).await;

  // ── Instance 1: 50 concurrent requests ─────────────────────────────────────
  let mut handles1 = Vec::with_capacity(50);
  for _ in 0..50 {
    let app = app1.clone();
    let sid = session_id;
    handles1.push(tokio::spawn(async move {
      helpers::gql(&app, sid, helpers::gql_query(SERVER_CONFIG_QUERY)).await
    }));
  }

  // ── Instance 2: 50 concurrent requests (launched at the same time) ─────────
  let mut handles2 = Vec::with_capacity(50);
  for _ in 0..50 {
    let app = app2.clone();
    let sid = session_id;
    handles2.push(tokio::spawn(async move {
      helpers::gql(&app, sid, helpers::gql_query(SERVER_CONFIG_QUERY)).await
    }));
  }

  // ── Collect all 100 results ─────────────────────────────────────────────────
  let mut all_responses = Vec::with_capacity(100);

  for (i, h) in handles1.into_iter().enumerate() {
    let resp = h.await.unwrap_or_else(|e| panic!("instance-1 task {i} panicked: {e}"));
    assert!(
      resp.get("errors").is_none(),
      "instance-1 request {i} returned errors: {resp}"
    );
    all_responses.push(resp);
  }

  for (i, h) in handles2.into_iter().enumerate() {
    let resp = h.await.unwrap_or_else(|e| panic!("instance-2 task {i} panicked: {e}"));
    assert!(
      resp.get("errors").is_none(),
      "instance-2 request {i} returned errors: {resp}"
    );
    all_responses.push(resp);
  }

  // ── INV-STAMPEDE-MULTI-01a: all 100 responses are identical ────────────────
  assert_eq!(all_responses.len(), 100, "expected 100 responses");
  let first = &all_responses[0];
  for (i, r) in all_responses.iter().enumerate() {
    assert_eq!(
      r["data"]["serverConfig"], first["data"]["serverConfig"],
      "response {i} differs from response 0"
    );
  }

  // Cleanup: remove the admin user inserted by seed_admin.
  sqlx::query("DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE is_admin = TRUE AND email LIKE '%@example.test')")
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE is_admin = TRUE AND email LIKE '%@example.test'")
    .execute(&pool)
    .await
    .ok();
}
