//! Git-Sync webhook HTTP ingress tests.

use crate::helpers;

use axum::body::Body;
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2::Sha256;
use tower::ServiceExt;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

async fn seed_webhook_profile(pool: &sqlx::PgPool, owner_id: Uuid) -> (Uuid, Uuid) {
  let workspace_id = helpers::create_workspace(pool, owner_id).await;
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES
       ($1, $2, $3, 'https://localhost/acme/repo.git', 'main', 'content/', 'Bidirectional', 'Webhook', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("seed webhook git sync profile");
  (workspace_id, profile_id)
}

fn sign(secret: &str, timestamp: i64, body: &[u8]) -> String {
  let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
  mac.update(timestamp.to_string().as_bytes());
  mac.update(b".");
  mac.update(body);
  format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

#[tokio::test]
async fn git_sync_webhook_validates_hmac_and_creates_pending_run() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  let secret = "git-sync-webhook-test-secret";
  let (app, pool, auth_store, queue) = helpers::setup_app_with_git_sync_webhook_and_queue(secret).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-webhook-owner").await;
  let (workspace_id, profile_id) = seed_webhook_profile(&pool, owner_id).await;

  let body = br#"{"ref":"refs/heads/main","after":"abc"}"#;
  let timestamp = chrono::Utc::now().timestamp();
  let signature = sign(secret, timestamp, body);

  let response = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", timestamp.to_string())
        .header("x-myoxus-signature", signature)
        .header("x-myoxus-delivery", "delivery-1")
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
  let bytes = response.into_body().collect().await.unwrap().to_bytes();
  let json: Value = serde_json::from_slice(&bytes).unwrap();
  assert_eq!(json["accepted"], true);
  assert_eq!(json["queued"], true, "accepted webhook must be durably dispatched");
  assert!(json["runId"].as_str().is_some(), "response must expose run id: {json}");
  let run_id = Uuid::parse_str(json["runId"].as_str().expect("run id")).expect("valid run id");

  let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("run count");
  assert_eq!(run_count, 1, "valid webhook must create exactly one pending run");
  let job_id: String = sqlx::query_scalar("SELECT job_id FROM git_sync_runs WHERE id = $1")
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .expect("webhook dispatch job id");
  let queued = queue
    .get_job("git-sync", &job_id)
    .await
    .expect("load webhook queue job")
    .expect("webhook queue job exists");
  assert_eq!(queued.data["trigger"], "Webhook");
  assert_eq!(queued.data["runId"], run_id.to_string());

  // This test owns webhook delivery idempotency, not remote-commit
  // verification. Use a valid terminal failure instead of fabricating the
  // verified Git revision required by a Completed run.
  sqlx::query(
    "UPDATE git_sync_runs SET status = 'Failed', error_class = 'InternalError', \
     error_message = 'webhook idempotency fixture', finished_at = now() WHERE id = $1",
  )
  .bind(run_id)
  .execute(&pool)
  .await
  .expect("mark first webhook run completed");

  let duplicate = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", timestamp.to_string())
        .header("x-myoxus-signature", sign(secret, timestamp, body))
        .header("x-myoxus-delivery", "delivery-1")
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(duplicate.status(), axum::http::StatusCode::ACCEPTED);
  let run_count_after_duplicate: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("run count after duplicate");
  assert_eq!(
    run_count_after_duplicate, 1,
    "duplicate delivery after a terminal run must still be durable-idempotent"
  );
  let delivery_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_webhook_deliveries WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("delivery count");
  assert_eq!(
    delivery_count, 1,
    "duplicate delivery must not create a second delivery row"
  );

  queue.empty_queue("git-sync").await.expect("clean webhook test queue");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn git_sync_webhook_persists_branch_rejections_without_creating_runs() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  let secret = "git-sync-webhook-test-secret";
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_webhook_secret(secret).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-webhook-branch-owner").await;
  let (workspace_id, profile_id) = seed_webhook_profile(&pool, owner_id).await;

  let body = br#"{"ref":"refs/heads/feature","after":"abc"}"#;
  let timestamp = chrono::Utc::now().timestamp();
  let response = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", timestamp.to_string())
        .header("x-myoxus-signature", sign(secret, timestamp, body))
        .header("x-myoxus-delivery", "branch-mismatch-1")
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
  let bytes = response.into_body().collect().await.unwrap().to_bytes();
  let json: Value = serde_json::from_slice(&bytes).unwrap();
  assert_eq!(json["accepted"], false);
  assert_eq!(json["queued"], false);
  assert_eq!(json["reason"], "webhook ref does not match profile branch");

  let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("run count");
  assert_eq!(run_count, 0, "wrong-branch webhook must not create runs");
  let rejected: (bool, String, String) = sqlx::query_as(
    "SELECT accepted, rejection_reason, ref_name FROM git_sync_webhook_deliveries WHERE profile_id = $1",
  )
  .bind(profile_id)
  .fetch_one(&pool)
  .await
  .expect("rejected delivery");
  assert!(!rejected.0);
  assert_eq!(rejected.1, "branch mismatch");
  assert_eq!(rejected.2, "refs/heads/feature");

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn git_sync_webhook_rejects_invalid_or_stale_signatures_without_artifacts() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  let secret = "git-sync-webhook-test-secret";
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_webhook_secret(secret).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-webhook-invalid-owner").await;
  let (workspace_id, profile_id) = seed_webhook_profile(&pool, owner_id).await;

  let body = br#"{"ref":"refs/heads/main"}"#;
  let timestamp = chrono::Utc::now().timestamp();
  let invalid = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", timestamp.to_string())
        .header("x-myoxus-signature", sign(secret, timestamp, br#"{"tampered":true}"#))
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(invalid.status(), axum::http::StatusCode::UNAUTHORIZED);

  let stale_timestamp = timestamp - 600;
  let stale = app
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", stale_timestamp.to_string())
        .header("x-myoxus-signature", sign(secret, stale_timestamp, body))
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(stale.status(), axum::http::StatusCode::UNAUTHORIZED);

  let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("run count");
  assert_eq!(run_count, 0, "rejected webhooks must not create run artifacts");
  let delivery_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_webhook_deliveries WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("delivery count");
  assert_eq!(
    delivery_count, 0,
    "invalid or stale signatures must remain artifact-free"
  );

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn git_sync_webhook_requires_global_git_sync_enabled() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  let secret = "git-sync-webhook-test-secret";
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_webhook_policy(secret, false).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-webhook-disabled-owner").await;
  let (workspace_id, profile_id) = seed_webhook_profile(&pool, owner_id).await;

  let body = br#"{"ref":"refs/heads/main"}"#;
  let timestamp = chrono::Utc::now().timestamp();
  let response = app
    .clone()
    .oneshot(
      axum::http::Request::builder()
        .method("POST")
        .uri(format!("/api/git-sync/webhook/{profile_id}"))
        .header("content-type", "application/json")
        .header("x-myoxus-timestamp", timestamp.to_string())
        .header("x-myoxus-signature", sign(secret, timestamp, body))
        .body(Body::from(body.as_slice()))
        .expect("request"),
    )
    .await
    .expect("response");

  assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
  let run_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("run count");
  assert_eq!(run_count, 0, "disabled Git-Sync policy must not create runs");

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
