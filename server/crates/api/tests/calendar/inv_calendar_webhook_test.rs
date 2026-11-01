// SPDX-License-Identifier: AGPL-3.0-or-later
//! P90-CAL-B-T01 — Invariant-first integration tests: Google Calendar webhook endpoint.
//!
//! Tests verify system-state invariants for the webhook endpoint:
//!
//! - INV-CAL-WH-01: unknown channel_id → 404
//! - INV-CAL-WH-02: known channel + resource_state="sync" → 200, no side-effects
//! - INV-CAL-WH-03: known channel + resource_state="exists" → 200, subscription
//!   `updated_at` touched in DB (proxy for delta-sync trigger)

use crate::helpers;

use axum::{body::Body, http::Request};
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::calendar::CalendarService;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

async fn test_state_webhook_enabled_with_pool(pool: sqlx::PgPool) -> ApiState {
  let mut config = AppConfig::load().expect("config");
  config.calendar.google_webhook.enabled = true;
  let calendar = Arc::new(CalendarService::new(Arc::new(SqlxCalendarRepository::new(
    pool.clone(),
  ))));
  ApiState::new(config)
    .with_metrics_pool(pool)
    .with_calendar_service(calendar)
}

// ---------------------------------------------------------------------------
// INV-CAL-WH-01 — POST with unknown X-Goog-Channel-ID returns 404
//
// Invariant: the webhook endpoint must reject unknown channel_ids with 404
// to prevent information leakage and ensure only registered channels get
// processed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_wh01_webhook_unknown_channel_rejected() {
  let pool = helpers::setup_pool().await;
  let app = build_router(test_state_webhook_enabled_with_pool(pool).await);
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", format!("unknown-channel-{}", Uuid::new_v4()))
        .header("x-goog-resource-id", "some-resource")
        .header("x-goog-resource-state", "exists")
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(
    response.status(),
    404,
    "INV-CAL-WH-01: unknown channel_id must return 404"
  );
}

// ---------------------------------------------------------------------------
// INV-CAL-WH-02 — resource_state="sync" with known channel returns 200
//
// Invariant: a "sync" state message is the channel confirmation from Google.
// It must be acknowledged with 200 and must NOT trigger any DB mutations.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_wh02_webhook_sync_state_returns_200() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv-cal-wh02", false).await;

  // Create a calendar_account + subscription with a known webhook_channel_json.
  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'google', $2, '{}'::jsonb) RETURNING id",
  )
  .bind(user_id)
  .bind(format!("wh02-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert account");

  let channel_id = Uuid::new_v4().to_string();
  let channel_json = serde_json::json!({
    "channel_id": channel_id,
    "resource_id": "res-wh02",
    "expiry": "2030-01-01T00:00:00Z"
  });
  sqlx::query(
    "INSERT INTO calendar_subscriptions (account_id, remote_calendar_id, webhook_channel_json, updated_at)
     VALUES ($1, 'primary', $2, now())",
  )
  .bind(account_id)
  .bind(&channel_json)
  .execute(&pool)
  .await
  .expect("insert subscription");

  // Record the updated_at before the webhook call.
  let before_ts: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT updated_at FROM calendar_subscriptions WHERE account_id = $1")
      .bind(account_id)
      .fetch_one(&pool)
      .await
      .expect("select updated_at before");

  let app = build_router(test_state_webhook_enabled_with_pool(pool.clone()).await);

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", &channel_id)
        .header("x-goog-resource-id", "res-wh02")
        .header("x-goog-resource-state", "sync")
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(response.status(), 200, "INV-CAL-WH-02: sync state must return 200");

  // Invariant: updated_at must NOT have changed (no side-effects for "sync").
  let after_ts: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT updated_at FROM calendar_subscriptions WHERE account_id = $1")
      .bind(account_id)
      .fetch_one(&pool)
      .await
      .expect("select updated_at after");

  assert_eq!(
    before_ts, after_ts,
    "INV-CAL-WH-02: sync state must not modify updated_at"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_subscriptions WHERE account_id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-WH-03 — resource_state="exists" with known channel returns 200
//        and touches subscription updated_at in DB
//
// Invariant: an "exists" notification triggers a delta-sync action.  We
// verify the DB side-effect: `updated_at` is advanced, which is the
// observable proxy for the sync trigger (no Redis required in this test).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_wh03_webhook_exists_state_touches_subscription() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "inv-cal-wh03", false).await;

  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts (user_id, provider, remote_account_id, config)
     VALUES ($1, 'google', $2, '{}'::jsonb) RETURNING id",
  )
  .bind(user_id)
  .bind(format!("wh03-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert account");

  let channel_id = Uuid::new_v4().to_string();
  let channel_json = serde_json::json!({
    "channel_id": channel_id,
    "resource_id": "res-wh03",
    "expiry": "2030-01-01T00:00:00Z"
  });

  let sub_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_subscriptions (account_id, remote_calendar_id, webhook_channel_json, updated_at)
     VALUES ($1, 'primary', $2, now() - interval '1 minute')
     RETURNING id",
  )
  .bind(account_id)
  .bind(&channel_json)
  .fetch_one(&pool)
  .await
  .expect("insert subscription");

  let before_ts: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT updated_at FROM calendar_subscriptions WHERE id = $1")
      .bind(sub_id)
      .fetch_one(&pool)
      .await
      .expect("select updated_at before");

  let app = build_router(test_state_webhook_enabled_with_pool(pool.clone()).await);

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", &channel_id)
        .header("x-goog-resource-id", "res-wh03")
        .header("x-goog-resource-state", "exists")
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(response.status(), 200, "INV-CAL-WH-03: exists state must return 200");

  // Invariant: updated_at must have advanced (DB side-effect of delta sync trigger).
  let after_ts: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT updated_at FROM calendar_subscriptions WHERE id = $1")
      .bind(sub_id)
      .fetch_one(&pool)
      .await
      .expect("select updated_at after");

  assert!(
    after_ts > before_ts,
    "INV-CAL-WH-03: exists state must advance updated_at (got before={before_ts}, after={after_ts})"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_subscriptions WHERE id = $1")
    .bind(sub_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// INV-CAL-WH-04 — wrong X-Goog-Channel-Token when secret is configured → 401
//
// Invariant (P92-CAL-FIX-A-02): when `calendar.google_webhook.token` is set in
// config, requests that carry a different token value must be rejected with
// 401 Unauthorized.  This prevents unauthorised parties from triggering
// delta-sync operations via forged webhook calls.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_cal_wh04_wrong_token_rejected() {
  let mut config = AppConfig::load().expect("config");
  config.calendar.google_webhook.enabled = true;
  config.calendar.google_webhook.token = Some("correct-secret".to_string());
  let app = build_router(ApiState::new(config));

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/api/calendar/webhook/google")
        .header("x-goog-channel-id", format!("some-channel-{}", Uuid::new_v4()))
        .header("x-goog-resource-id", "some-resource")
        .header("x-goog-resource-state", "exists")
        .header("x-goog-channel-token", "wrong-token")
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(
    response.status(),
    401,
    "INV-CAL-WH-04: wrong channel token must be rejected with 401 when secret is configured"
  );
}
