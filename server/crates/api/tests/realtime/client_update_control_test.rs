// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::helpers;

use axum::{
  body::Body,
  http::{Request, header},
};
use http_body_util::BodyExt;
use myoxus_api::client_update_runtime::ClientUpdateRuntime;
use myoxus_application::client_update::ClientUpdateCommand;
use myoxus_contracts::client_update::CLIENT_UPDATE_CONFIG_KEY;
use myoxus_infrastructure::client_update::PgClientUpdateRepository;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn query_control(app: &axum::Router) -> (http::HeaderMap, Value) {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
            "query": "query { clientUpdateControl { schemaVersion stateId phase operationId maxAttempts retryAfterMs cacheEpoch updatedAt } }"
          })
          .to_string(),
        ))
        .expect("GraphQL request"),
    )
    .await
    .expect("GraphQL response");
  let headers = response.headers().clone();
  let body = response.into_body().collect().await.expect("GraphQL body").to_bytes();
  (headers, serde_json::from_slice(&body).expect("GraphQL JSON"))
}

async fn cleanup_control(pool: &PgPool) {
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(CLIENT_UPDATE_CONFIG_KEY)
    .execute(pool)
    .await
    .expect("client update control cleanup");
}

#[tokio::test]
async fn client_update_query_is_cache_free_and_consistent_across_nodes() {
  let _guard = helpers::CLIENT_UPDATE_CONTROL_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let pool = helpers::setup_pool().await;
  cleanup_control(&pool).await;
  let (node_a, _, _) = helpers::setup_app_with_pool(pool.clone()).await;
  let (node_b, _, _) = helpers::setup_app_with_pool(pool.clone()).await;

  let (headers, baseline) = query_control(&node_a).await;
  assert_eq!(
    headers.get(header::CACHE_CONTROL).and_then(|value| value.to_str().ok()),
    Some("no-store")
  );
  assert_eq!(baseline["data"]["clientUpdateControl"]["phase"], "normal");

  let repository = PgClientUpdateRepository::new(pool.clone());
  let operation_id = Uuid::new_v4();
  let transition = repository
    .apply(ClientUpdateCommand::LimitRetry {
      operation_id,
      max_attempts: 4,
      retry_after_ms: 2_000,
    })
    .await
    .expect("persist limited policy");
  assert!(transition.changed);
  // Deliberately omit repository.notify(): the next authoritative query must
  // still converge instead of relying on the wake-up.
  let (_, after_lost_wakeup_a) = query_control(&node_a).await;
  let (_, after_lost_wakeup_b) = query_control(&node_b).await;
  let a = &after_lost_wakeup_a["data"]["clientUpdateControl"];
  let b = &after_lost_wakeup_b["data"]["clientUpdateControl"];
  assert_eq!(a, b, "all API nodes must project the same PostgreSQL revision");
  assert_eq!(a["stateId"], transition.state.state_id.to_string());
  assert_eq!(a["phase"], "limited");
  assert_eq!(a["maxAttempts"], 4);

  cleanup_control(&pool).await;
}

#[tokio::test]
async fn corrupt_client_update_control_fails_closed_in_graphql() {
  let _guard = helpers::CLIENT_UPDATE_CONTROL_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let pool = helpers::setup_pool().await;
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at) VALUES ($1, $2, now(), now()) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .bind(CLIENT_UPDATE_CONFIG_KEY)
  .bind(json!({"schemaVersion": 1, "phase": "normal"}))
  .execute(&pool)
  .await
  .expect("seed corrupt client update control");
  let (app, _, _) = helpers::setup_app_with_pool(pool.clone()).await;

  let (_, response) = query_control(&app).await;
  assert!(
    response["data"]["clientUpdateControl"].is_null(),
    "corrupt state must never normalize to normal: {response}"
  );
  assert_eq!(
    response["errors"][0]["extensions"]["code"],
    "CLIENT_UPDATE_CONTROL_UNAVAILABLE"
  );

  cleanup_control(&pool).await;
}

async fn independent_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  PgPoolOptions::new()
    // One long-lived LISTEN connection plus one authoritative read.
    .max_connections(2)
    .connect(&url)
    .await
    .expect("independent test pool")
}

async fn wait_until_ready(runtime: &ClientUpdateRuntime) {
  let mut ready = runtime.listener_ready();
  tokio::time::timeout(std::time::Duration::from_secs(5), ready.wait_for(|value| *value))
    .await
    .expect("listener readiness timeout")
    .expect("listener readiness channel closed");
}

#[tokio::test]
async fn postgres_wakeup_reaches_two_api_node_runtimes() {
  let _guard = helpers::CLIENT_UPDATE_CONTROL_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let writer_pool = helpers::setup_pool().await;
  cleanup_control(&writer_pool).await;
  let node_a = ClientUpdateRuntime::new(independent_pool().await);
  let node_b = ClientUpdateRuntime::new(independent_pool().await);
  let mut wakeup_a = node_a.subscribe_wakeups();
  let mut wakeup_b = node_b.subscribe_wakeups();
  let listener_a = node_a.start_listener();
  let listener_b = node_b.start_listener();
  wait_until_ready(&node_a).await;
  wait_until_ready(&node_b).await;

  let repository = PgClientUpdateRepository::new(writer_pool.clone());
  let transition = repository
    .apply(ClientUpdateCommand::LimitRetry {
      operation_id: Uuid::new_v4(),
      max_attempts: 2,
      retry_after_ms: 1_000,
    })
    .await
    .expect("persist update policy");
  repository
    .notify(transition.state.state_id)
    .await
    .expect("publish PostgreSQL wake-up");

  tokio::time::timeout(std::time::Duration::from_secs(5), wakeup_a.recv())
    .await
    .expect("node A wake-up timeout")
    .expect("node A wake-up channel");
  tokio::time::timeout(std::time::Duration::from_secs(5), wakeup_b.recv())
    .await
    .expect("node B wake-up timeout")
    .expect("node B wake-up channel");
  assert_eq!(
    node_a.read_authoritative().await.expect("node A state"),
    node_b.read_authoritative().await.expect("node B state")
  );

  node_a.shutdown();
  node_b.shutdown();
  listener_a.await.expect("node A listener shutdown");
  listener_b.await.expect("node B listener shutdown");
  cleanup_control(&writer_pool).await;
}
