//! Distributed Socket.IO connection-admission invariants.
//!
//! These tests intentionally use the isolated real Redis service. An in-memory
//! fake cannot prove atomicity or a shared window across API replicas.

use std::sync::Arc;

use myoxus_api::websocket::redis_adapter::RedisWsAdapter;
use myoxus_infrastructure::redis::RedisAdapter;
use uuid::Uuid;

fn redis_url() -> String {
  std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string())
}

fn adapter(url: &str, namespace: &str) -> RedisWsAdapter {
  RedisWsAdapter::new(
    Uuid::new_v4(),
    Arc::new(RedisAdapter::new(url, namespace).expect("valid isolated test Redis URL")),
  )
}

#[tokio::test]
async fn distributed_connection_admission_enforces_both_windows_atomically() {
  let default_namespace = format!("connection-admission-default-{}", Uuid::new_v4());
  let default_adapter = adapter(&redis_url(), &default_namespace);
  let account = format!("account-{}", Uuid::new_v4());
  let session = format!("session-{}", Uuid::new_v4());

  for attempt in 1..=10 {
    let decision = default_adapter
      .admit_connection(&session, &account, 10)
      .await
      .expect("real Redis admission");
    assert!(
      decision.accepted,
      "default attempt {attempt} must be admitted: {decision:?}"
    );
    assert_eq!(decision.session_attempts, attempt);
    assert_eq!(decision.account_attempts, attempt);
  }
  let rejected = default_adapter
    .admit_connection(&session, &account, 10)
    .await
    .expect("eleventh Redis admission");
  assert!(!rejected.accepted, "the eleventh attempt must be rejected");
  assert!((1..=1_000).contains(&rejected.retry_after_ms));

  let shared_namespace = format!("connection-admission-shared-{}", Uuid::new_v4());
  let first_replica = adapter(&redis_url(), &shared_namespace);
  let second_replica = adapter(&redis_url(), &shared_namespace);
  let shared_account = format!("account-{}", Uuid::new_v4());

  assert!(
    first_replica
      .admit_connection("session-a", &shared_account, 2)
      .await
      .expect("first replica admission")
      .accepted
  );
  assert!(
    second_replica
      .admit_connection("session-b", &shared_account, 2)
      .await
      .expect("second replica admission")
      .accepted
  );
  let account_rejection = first_replica
    .admit_connection("session-c", &shared_account, 2)
    .await
    .expect("shared account admission");
  assert!(
    !account_rejection.accepted,
    "multiple sessions across replicas must not bypass the account window"
  );
  assert_eq!(account_rejection.session_attempts, 1);
  assert_eq!(account_rejection.account_attempts, 3);
}

#[tokio::test]
async fn connection_admission_transport_failure_has_no_local_fallback() {
  let unavailable = adapter(
    "redis://127.0.0.1:1",
    &format!("connection-admission-unavailable-{}", Uuid::new_v4()),
  );
  let error = unavailable
    .admit_connection("session", "account", 10)
    .await
    .expect_err("an unavailable Redis service must surface an adapter error");
  assert!(error.contains("unavailable"), "unexpected Redis error: {error}");
}
