//! Git-Sync scheduler selection and Cron admission tests.
//!
//! Polling tests stop before dispatch; Cron tests use an isolated Redis queue
//! to prove durable slot admission and exactly-once publication together.

use chrono::{Duration, Utc};
use serde_json::json;
use uuid::Uuid;

use myoxus_api::config::GitSyncPolicyConfig;
use myoxus_api::git_sync_engine::policy::{EffectiveGitSyncPolicy, resolve_git_sync_policy};
use myoxus_api::git_sync_engine::scheduler::{
  admit_due_cron_profiles, admit_due_token_rotations, due_polling_profiles,
};
use myoxus_application::git_sync::{
  GitSyncLifecycleStore, GitTokenRotationConfiguration, GitTokenRotationProviderKind, GitTokenRotationService,
  GitTokenRotationState, GitTokenRotationStore,
};
use myoxus_domain::git_sync::{GitSyncRunSource, SyncDirection, TriggerMode};
use myoxus_infrastructure::git_sync::{GitLabTokenRotationAdapter, GitSyncTokenCredentialCodec, SqlxGitSyncStore};
use myoxus_worker::RedisQueue;

use crate::helpers;

fn history_capture_policy() -> myoxus_application::git_sync::GitSyncLifecyclePolicy {
  myoxus_application::git_sync::GitSyncLifecyclePolicy {
    enabled: true,
    allowed_directions: std::collections::HashSet::from([SyncDirection::Bidirectional, SyncDirection::MyoxusToGit]),
    allowed_auth_methods: std::collections::HashSet::from([myoxus_domain::git_sync::AuthMethod::HttpsToken]),
    allowed_hosts: std::collections::HashSet::from(["history-capture.test".to_string()]),
    auto_sync_allowed: true,
    webhook_allowed: true,
  }
}

async fn insert_history_capture(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid) -> i64 {
  let mut tx = pool.begin().await.unwrap();
  let history_id: i64 = sqlx::query_scalar(
    "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, origin)
     VALUES ($1, $2, $3, 'manual') RETURNING id",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(b"history-trigger" as &[u8])
  .fetch_one(&mut *tx)
  .await
  .unwrap();
  myoxus_infrastructure::history_git_sync::record_history_capture(&mut tx, workspace_id, history_id)
    .await
    .unwrap();
  tx.commit().await.unwrap();
  history_id
}

async fn upsert_app_config(pool: &sqlx::PgPool, id: &str, value: serde_json::Value) {
  sqlx::query(
    r#"
    INSERT INTO app_configs (id, value)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    "#,
  )
  .bind(id)
  .bind(value)
  .execute(pool)
  .await
  .expect("upsert app config");
}

async fn cleanup_git_sync_policy(pool: &sqlx::PgPool) {
  sqlx::query("DELETE FROM app_configs WHERE id LIKE 'git_sync.%'")
    .execute(pool)
    .await
    .ok();
}

async fn effective_policy(pool: &sqlx::PgPool) -> EffectiveGitSyncPolicy {
  let overrides = myoxus_infrastructure::app_config::load_validated_app_config_values(pool)
    .await
    .expect("load canonical Git-Sync overrides");
  resolve_git_sync_policy(&GitSyncPolicyConfig::default(), &overrides).expect("resolve Git-Sync policy")
}

async fn insert_polling_profile(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  owner_id: Uuid,
  host: &str,
  suffix: &str,
  polling_interval_secs: Option<i64>,
  enabled: bool,
) -> Uuid {
  let profile_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_profiles
      (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
       trigger_mode, polling_interval_secs, auth_method, credential_id, enabled)
    VALUES
      ($1, $2, $3, $4, 'main', 'content/', 'Bidirectional',
       'Polling', $5, 'HttpsToken', NULL, $6)
    "#,
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .bind(format!("https://{host}/acme/{suffix}.git"))
  .bind(polling_interval_secs)
  .bind(enabled)
  .execute(pool)
  .await
  .expect("insert polling profile");
  profile_id
}

async fn insert_run(
  pool: &sqlx::PgPool,
  profile_id: Uuid,
  status: &str,
  started_offset_secs: i64,
  finished_offset_secs: Option<i64>,
) -> Uuid {
  let now = Utc::now();
  let run_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_runs
      (id, profile_id, direction, status, started_at, finished_at,
       commit_after, observed_remote_oid, job_id)
    VALUES
      ($1, $2, 'Bidirectional', $3, $4, $5,
       CASE WHEN $3 = 'Completed' THEN 'scheduler-test-terminal-revision' ELSE NULL END,
       CASE WHEN $3 = 'Completed' THEN 'scheduler-test-terminal-revision' ELSE NULL END,
       CASE WHEN $3 = 'Running' THEN 'scheduler-test-running-job' ELSE NULL END)
    "#,
  )
  .bind(run_id)
  .bind(profile_id)
  .bind(status)
  .bind(now - Duration::seconds(started_offset_secs))
  .bind(finished_offset_secs.map(|secs| now - Duration::seconds(secs)))
  .execute(pool)
  .await
  .expect("insert git sync run");
  run_id
}

async fn insert_cron_profile(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  owner_id: Uuid,
  next: chrono::DateTime<Utc>,
  misfire: &str,
) -> Uuid {
  let profile_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_profiles
      (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
       trigger_mode, polling_interval_secs, cron_expression, cron_timezone,
       cron_misfire_policy, cron_next_scheduled_at, auth_method, enabled)
    VALUES
      ($1, $2, $3, 'https://scheduler-cron.test/acme/repo.git', 'main',
       'content/', 'Bidirectional', 'Cron', NULL, '0 * * * *', 'UTC',
       $5, $4, 'HttpsToken', true)
    "#,
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .bind(next)
  .bind(misfire)
  .execute(pool)
  .await
  .expect("insert Cron profile");
  profile_id
}

fn cron_lifecycle_policy() -> myoxus_application::git_sync::GitSyncLifecyclePolicy {
  myoxus_application::git_sync::GitSyncLifecyclePolicy {
    enabled: true,
    allowed_directions: std::collections::HashSet::from([SyncDirection::Bidirectional]),
    allowed_auth_methods: std::collections::HashSet::from([myoxus_domain::git_sync::AuthMethod::HttpsToken]),
    allowed_hosts: std::collections::HashSet::from(["scheduler-cron.test".to_string()]),
    auto_sync_allowed: true,
    webhook_allowed: true,
  }
}

async fn insert_rotation_profile(pool: &sqlx::PgPool, workspace_id: Uuid, owner_id: Uuid, suffix: &str) -> Uuid {
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path,
        sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, $4, 'main', 'content/', 'Bidirectional',
             'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .bind(format!("https://gitlab.example.test/acme/{suffix}.git"))
  .execute(pool)
  .await
  .expect("insert rotation profile");
  let credential_id: Uuid = sqlx::query_scalar(
    "INSERT INTO git_sync_credentials
       (profile_id, auth_method, label, encrypted_data, expires_at)
     VALUES ($1, 'HttpsToken', 'scheduler-token', $2, $3)
     RETURNING id",
  )
  .bind(profile_id)
  .bind(vec![1_u8, 2, 3])
  .bind(Utc::now() + Duration::days(7))
  .fetch_one(pool)
  .await
  .expect("insert rotation credential");
  sqlx::query("UPDATE git_sync_profiles SET credential_id = $2 WHERE id = $1")
    .bind(profile_id)
    .bind(credential_id)
    .execute(pool)
    .await
    .expect("activate rotation credential");
  profile_id
}

#[tokio::test]
async fn duplicate_token_rotation_ticks_publish_one_identifier_only_job_and_defer_active_runs() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-token-rotation-scheduler").await;
  let due_workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let busy_workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let due_profile = insert_rotation_profile(&pool, due_workspace_id, owner_id, "due").await;
  let busy_profile = insert_rotation_profile(&pool, busy_workspace_id, owner_id, "busy").await;
  let store = SqlxGitSyncStore::new(pool.clone());
  for profile_id in [due_profile, busy_profile] {
    GitTokenRotationStore::configure(
      &store,
      profile_id,
      GitTokenRotationConfiguration {
        provider: GitTokenRotationProviderKind::GitLab,
        enabled: true,
        renew_before_days: 30,
        requested_lifetime_days: 90,
      },
    )
    .await
    .expect("configure token rotation");
  }
  store
    .create_pending_run_if_absent(busy_profile, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .expect("admit active Git-Sync run");

  let service = GitTokenRotationService::new(
    std::sync::Arc::new(SqlxGitSyncStore::new(pool.clone())),
    std::sync::Arc::new(GitSyncTokenCredentialCodec::new("scheduler-fixture-key")),
    vec![std::sync::Arc::new(
      GitLabTokenRotationAdapter::new(std::time::Duration::from_secs(5), None).expect("build GitLab adapter"),
    )],
  );
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue = RedisQueue::new(
    &redis_url,
    format!("git-sync-token-rotation-{}", Uuid::new_v4().as_simple()),
  )
  .expect("isolated token-rotation Redis queue");
  let now = Utc::now();
  let (left, right) = tokio::join!(
    admit_due_token_rotations(&queue, &service, now, 100),
    admit_due_token_rotations(&queue, &service, now, 100),
  );
  assert_eq!(left.expect("first tick") + right.expect("second tick"), 1);
  let status = GitTokenRotationStore::status(&store, due_profile)
    .await
    .expect("due rotation status")
    .expect("due rotation row");
  assert_eq!(status.state, GitTokenRotationState::Rotating);
  let busy_status = GitTokenRotationStore::status(&store, busy_profile)
    .await
    .expect("busy rotation status")
    .expect("busy rotation row");
  assert_eq!(busy_status.state, GitTokenRotationState::Configured);

  let (jobs, total) = queue
    .list_jobs("git-sync", "waiting", 0, 10)
    .await
    .expect("list token-rotation jobs");
  assert_eq!(total, 1);
  assert_eq!(jobs[0]["name"], "git-sync.tokenRotation");
  let payload = jobs[0]["data"].clone();
  assert_eq!(
    payload.as_object().map(serde_json::Map::len),
    Some(2),
    "Redis receives identifiers only"
  );
  assert_eq!(payload["profileId"], due_profile.to_string());
  assert_eq!(
    payload["attemptId"],
    status.latest_attempt_id.expect("admitted attempt").to_string()
  );

  queue.empty_queue("git-sync").await.expect("clean rotation test queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn duplicate_cron_ticks_dispatch_one_durable_slot_and_manual_runs_preserve_schedule() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-cron-slots").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T05:00:20Z")
    .unwrap()
    .with_timezone(&Utc);
  let profile_id = insert_cron_profile(
    &pool,
    workspace_id,
    owner_id,
    chrono::DateTime::parse_from_rfc3339("2026-01-01T05:00:00Z")
      .unwrap()
      .with_timezone(&Utc),
    "RunOnce",
  )
  .await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  upsert_app_config(&pool, "git_sync.auto_sync_allowed", json!(true)).await;
  upsert_app_config(&pool, "git_sync.allowed_hosts", json!(["scheduler-cron.test"])).await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue = RedisQueue::new(
    &redis_url,
    format!("git-sync-cron-slots-{}", Uuid::new_v4().as_simple()),
  )
  .expect("isolated Cron Redis queue");
  let first_queue = queue.clone();
  let second_queue = queue.clone();
  let policy = effective_policy(&pool).await;
  let (left, right) = tokio::join!(
    admit_due_cron_profiles(&pool, &first_queue, &policy, now, 100),
    admit_due_cron_profiles(&pool, &second_queue, &policy, now, 100)
  );
  assert_eq!(
    left.unwrap() + right.unwrap(),
    1,
    "two handlers must process one due profile"
  );
  let admitted = sqlx::query_as::<_, (Uuid, String, chrono::DateTime<Utc>)>(
    "SELECT id, trigger_source, scheduled_for
     FROM git_sync_runs
     WHERE profile_id = $1",
  )
  .bind(profile_id)
  .fetch_all(&pool)
  .await
  .unwrap();
  assert_eq!(admitted.len(), 1, "duplicate ticks must persist one UTC slot");
  assert_eq!(admitted[0].1, "Cron");
  assert_eq!(admitted[0].2.to_rfc3339(), "2026-01-01T05:00:00+00:00");
  let (_, waiting) = queue
    .list_jobs("git-sync", "waiting", 0, 10)
    .await
    .expect("list Cron dispatch jobs");
  assert_eq!(waiting, 1, "duplicate ticks must publish one stable run delivery");
  let next: chrono::DateTime<Utc> =
    sqlx::query_scalar("SELECT cron_next_scheduled_at FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(next.to_rfc3339(), "2026-01-01T06:00:00+00:00");

  sqlx::query(
    "UPDATE git_sync_runs
     SET status = 'Completed',
         finished_at = now(),
         commit_after = 'scheduler-test-terminal-revision',
         observed_remote_oid = 'scheduler-test-terminal-revision'
     WHERE id = $1",
  )
  .bind(admitted[0].0)
  .execute(&pool)
  .await
  .unwrap();
  let store = SqlxGitSyncStore::new(pool.clone());
  let (manual, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .unwrap();
  assert!(inserted);
  assert_eq!(manual.trigger_source, GitSyncRunSource::Manual);
  let after_manual: chrono::DateTime<Utc> =
    sqlx::query_scalar("SELECT cron_next_scheduled_at FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  assert_eq!(after_manual, next, "manual ingress must not advance Cron state");

  queue.empty_queue("git-sync").await.expect("clean Cron test queue");
  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn cron_misfire_and_overlap_state_survive_until_the_profile_is_idle() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-cron-misfire").await;
  let store = SqlxGitSyncStore::new(pool.clone());
  let policy = cron_lifecycle_policy();
  let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T05:10:00Z")
    .unwrap()
    .with_timezone(&Utc);
  let stale_slot = chrono::DateTime::parse_from_rfc3339("2026-01-01T02:00:00Z")
    .unwrap()
    .with_timezone(&Utc);

  let skip_profile = insert_cron_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    stale_slot,
    "Skip",
  )
  .await;
  let skipped = store
    .admit_next_due_cron(now, &policy)
    .await
    .expect("admit skipped outage")
    .expect("due Skip profile");
  assert_eq!(skipped.profile_id, skip_profile);
  assert!(skipped.run.is_none(), "Skip must not create an outage catch-up run");
  assert_eq!(skipped.skipped_occurrences, 4);

  let run_once_profile = insert_cron_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    stale_slot,
    "RunOnce",
  )
  .await;
  let catch_up = store
    .admit_next_due_cron(now, &policy)
    .await
    .expect("admit RunOnce outage")
    .expect("due RunOnce profile");
  assert_eq!(catch_up.profile_id, run_once_profile);
  let catch_up_run = catch_up.run.expect("RunOnce must create one catch-up run");
  assert_eq!(
    catch_up_run.scheduled_for.unwrap().to_rfc3339(),
    "2026-01-01T05:00:00+00:00",
    "RunOnce must retain only the most recent missed UTC slot"
  );
  sqlx::query(
    "UPDATE git_sync_runs
     SET status = 'Completed',
         finished_at = now(),
         commit_after = 'scheduler-test-terminal-revision',
         observed_remote_oid = 'scheduler-test-terminal-revision'
     WHERE id = $1",
  )
  .bind(catch_up_run.id)
  .execute(&pool)
  .await
  .unwrap();

  let overlap_profile = insert_cron_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    stale_slot,
    "RunOnce",
  )
  .await;
  let unfinished_id = insert_run(&pool, overlap_profile, "Pending", 0, None).await;
  let overlap = store
    .admit_next_due_cron(now, &policy)
    .await
    .expect("record overlap")
    .expect("due overlapping profile");
  assert_eq!(overlap.profile_id, overlap_profile);
  assert!(
    overlap.run.is_none(),
    "an unfinished run must block parallel Cron admission"
  );
  assert_eq!(
    overlap.pending_misfire_scheduled_for.unwrap().to_rfc3339(),
    "2026-01-01T05:00:00+00:00"
  );
  sqlx::query(
    "UPDATE git_sync_runs
     SET status = 'Completed',
         finished_at = now(),
         commit_after = 'scheduler-test-terminal-revision',
         observed_remote_oid = 'scheduler-test-terminal-revision'
     WHERE id = $1",
  )
  .bind(unfinished_id)
  .execute(&pool)
  .await
  .unwrap();
  let resumed = store
    .admit_next_due_cron(now, &policy)
    .await
    .expect("admit retained overlap")
    .expect("pending overlap must remain due");
  let resumed_run = resumed.run.expect("idle profile must admit the retained slot");
  assert_eq!(resumed_run.trigger_source, GitSyncRunSource::Cron);
  assert_eq!(
    resumed_run.scheduled_for.unwrap().to_rfc3339(),
    "2026-01-01T05:00:00+00:00"
  );
  assert!(resumed.pending_misfire_scheduled_for.is_none());

  let counts = sqlx::query_as::<_, (Uuid, i64)>(
    "SELECT profile_id, COUNT(*)
     FROM git_sync_runs
     WHERE profile_id IN ($1, $2, $3) AND trigger_source = 'Cron'
     GROUP BY profile_id",
  )
  .bind(skip_profile)
  .bind(run_once_profile)
  .bind(overlap_profile)
  .fetch_all(&pool)
  .await
  .unwrap();
  assert_eq!(
    counts.len(),
    2,
    "Skip must have no Cron run; each RunOnce profile has one"
  );
  assert!(counts.iter().all(|(_, count)| *count == 1));

  let future_profile = insert_cron_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    now + Duration::hours(1),
    "RunOnce",
  )
  .await;
  sqlx::query(
    "UPDATE git_sync_profiles
     SET cron_pending_misfire_scheduled_for = $2
     WHERE id = $1",
  )
  .bind(future_profile)
  .bind(now + Duration::minutes(30))
  .execute(&pool)
  .await
  .unwrap();
  assert!(
    store.admit_next_due_cron(now, &policy).await.unwrap().is_none(),
    "a future pending slot must not be admitted early"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn history_capture_receipts_survive_conflicts_and_admit_only_outgoing_runs() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-history-capture").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id: Uuid = sqlx::query_scalar(
    "INSERT INTO docs (workspace_id, title, created_by)
     VALUES ($1, 'History capture', $2) RETURNING id",
  )
  .bind(workspace_id)
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path,
        sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://history-capture.test/acme/repo.git',
       'main', 'content/', 'Bidirectional', 'HistoryCapture', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .unwrap();

  let store = SqlxGitSyncStore::new(pool.clone());
  let policy = history_capture_policy();
  let first_history = insert_history_capture(&pool, workspace_id, doc_id).await;
  let first = store
    .admit_history_capture(profile_id, first_history, 1, &policy)
    .await
    .unwrap()
    .expect("first capture admits a run");
  assert_eq!(first.direction, SyncDirection::MyoxusToGit);
  assert_eq!(first.trigger_source, GitSyncRunSource::HistoryCapture);
  assert!(
    store
      .admit_history_capture(profile_id, first_history, 1, &policy)
      .await
      .unwrap()
      .is_none(),
    "redelivery after assignment is idempotent"
  );

  sqlx::query("UPDATE git_sync_runs SET status='Running', job_id='history-running' WHERE id=$1")
    .bind(first.id)
    .execute(&pool)
    .await
    .unwrap();
  let during_run = insert_history_capture(&pool, workspace_id, doc_id).await;
  assert!(
    store
      .drain_history_capture_intents(&policy, 10)
      .await
      .unwrap()
      .is_empty()
  );
  let assigned_during_run: Option<Uuid> = sqlx::query_scalar(
    "SELECT assigned_run_id FROM git_sync_history_capture_receipts
     WHERE profile_id=$1 AND history_id=$2",
  )
  .bind(profile_id)
  .bind(during_run)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert!(assigned_during_run.is_none());

  sqlx::query(
    "UPDATE git_sync_runs SET status='Completed', finished_at=now(),
       commit_after='history-complete', observed_remote_oid='history-complete'
     WHERE id=$1",
  )
  .bind(first.id)
  .execute(&pool)
  .await
  .unwrap();
  let recovered = store.drain_history_capture_intents(&policy, 10).await.unwrap();
  assert_eq!(recovered.len(), 1, "scheduler recovery admits the deferred capture");
  assert_ne!(recovered[0].id, first.id);
  sqlx::query("UPDATE git_sync_runs SET status='Cancelled', finished_at=now() WHERE id=$1")
    .bind(recovered[0].id)
    .execute(&pool)
    .await
    .unwrap();

  let policy_blocked = insert_history_capture(&pool, workspace_id, doc_id).await;
  let mut revoked_policy = policy.clone();
  revoked_policy.auto_sync_allowed = false;
  assert!(
    store
      .drain_history_capture_intents(&revoked_policy, 10)
      .await
      .unwrap()
      .is_empty(),
    "revoked automatic-sync policy must leave the durable intent pending"
  );
  let resumed = store.drain_history_capture_intents(&policy, 10).await.unwrap();
  assert_eq!(resumed.len(), 1, "policy restoration must admit the retained intent");
  let assigned_after_policy: Option<Uuid> = sqlx::query_scalar(
    "SELECT assigned_run_id FROM git_sync_history_capture_receipts
     WHERE profile_id=$1 AND history_id=$2",
  )
  .bind(profile_id)
  .bind(policy_blocked)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(assigned_after_policy, Some(resumed[0].id));
  sqlx::query("UPDATE git_sync_runs SET status='Cancelled', finished_at=now() WHERE id=$1")
    .bind(resumed[0].id)
    .execute(&pool)
    .await
    .unwrap();

  let manual = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .unwrap()
    .0;
  let _behind_manual = insert_history_capture(&pool, workspace_id, doc_id).await;
  assert!(
    store
      .drain_history_capture_intents(&policy, 10)
      .await
      .unwrap()
      .is_empty()
  );
  sqlx::query("UPDATE git_sync_runs SET status='Cancelled', finished_at=now() WHERE id=$1")
    .bind(manual.id)
    .execute(&pool)
    .await
    .unwrap();
  assert_eq!(store.drain_history_capture_intents(&policy, 10).await.unwrap().len(), 1);
  let stale_generation = insert_history_capture(&pool, workspace_id, doc_id).await;

  let mut profile = GitSyncLifecycleStore::profile(&store, profile_id).await.unwrap();
  profile.trigger_mode = TriggerMode::Manual;
  let switched = GitSyncLifecycleStore::update_profile(&store, profile, None)
    .await
    .unwrap();
  let mut reenabled = switched;
  reenabled.trigger_mode = TriggerMode::HistoryCapture;
  GitSyncLifecycleStore::update_profile(&store, reenabled, None)
    .await
    .unwrap();
  let delayed = store
    .admit_history_capture(profile_id, stale_generation, 1, &policy)
    .await
    .unwrap();
  assert!(delayed.is_none(), "old-generation delivery cannot resurrect work");
  let discarded: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
    "SELECT discarded_at FROM git_sync_history_capture_receipts
     WHERE profile_id=$1 AND history_id=$2",
  )
  .bind(profile_id)
  .bind(stale_generation)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert!(
    discarded.is_some(),
    "switching away must terminally discard old-generation intent"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn polling_due_selection_respects_global_and_auto_policy() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  cleanup_git_sync_policy(&pool).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-scheduler-policy").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let profile_id = insert_polling_profile(
    &pool,
    workspace_id,
    owner_id,
    "scheduler-policy.test",
    "policy",
    Some(60),
    true,
  )
  .await;

  upsert_app_config(&pool, "git_sync.enabled", json!(false)).await;
  upsert_app_config(&pool, "git_sync.allowed_hosts", json!(["scheduler-policy.test"])).await;
  let disabled = due_polling_profiles(&pool, &effective_policy(&pool).await, Utc::now())
    .await
    .expect("due selection");
  assert!(
    disabled.is_empty(),
    "git_sync.enabled=false must block polling candidates"
  );

  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  upsert_app_config(&pool, "git_sync.auto_sync_allowed", json!(false)).await;
  let auto_disabled = due_polling_profiles(&pool, &effective_policy(&pool).await, Utc::now())
    .await
    .expect("due selection");
  assert!(
    auto_disabled.is_empty(),
    "git_sync.auto_sync_allowed=false must block polling candidates"
  );

  upsert_app_config(&pool, "git_sync.auto_sync_allowed", json!(true)).await;
  let enabled = due_polling_profiles(&pool, &effective_policy(&pool).await, Utc::now())
    .await
    .expect("due selection");
  assert_eq!(
    enabled.iter().map(|c| c.profile_id).collect::<Vec<_>>(),
    vec![profile_id],
    "policy-enabled polling profile without prior runs must be due"
  );

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn polling_due_selection_uses_latest_activity_for_every_run_status() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  upsert_app_config(&pool, "git_sync.auto_sync_allowed", json!(true)).await;
  upsert_app_config(&pool, "git_sync.allowed_hosts", json!(["scheduler-interval.test"])).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-scheduler-interval").await;
  let completed_recent = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-interval.test",
    "completed-recent",
    Some(60),
    true,
  )
  .await;
  insert_run(&pool, completed_recent, "Completed", 20, Some(10)).await;
  let failed_recent = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-interval.test",
    "failed-recent",
    Some(60),
    true,
  )
  .await;
  insert_run(&pool, failed_recent, "Failed", 20, Some(10)).await;
  let pending_recent = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-interval.test",
    "pending-recent",
    Some(60),
    true,
  )
  .await;
  insert_run(&pool, pending_recent, "Pending", 10, None).await;
  let running_recent = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-interval.test",
    "running-recent",
    Some(60),
    true,
  )
  .await;
  insert_run(&pool, running_recent, "Running", 10, None).await;
  let completed_old = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-interval.test",
    "completed-old",
    Some(60),
    true,
  )
  .await;
  insert_run(&pool, completed_old, "Completed", 180, Some(120)).await;

  let due = due_polling_profiles(&pool, &effective_policy(&pool).await, Utc::now())
    .await
    .expect("due selection");
  let due_ids = due.iter().map(|c| c.profile_id).collect::<Vec<_>>();

  assert!(
    !due_ids.contains(&completed_recent),
    "recent completed run must block until interval elapsed"
  );
  assert!(
    !due_ids.contains(&failed_recent),
    "recent failed run must block until interval elapsed"
  );
  assert!(
    !due_ids.contains(&pending_recent),
    "recent pending run must block until interval elapsed"
  );
  assert!(
    !due_ids.contains(&running_recent),
    "recent running run must block until interval elapsed"
  );
  assert!(
    due_ids.contains(&completed_old),
    "profile must become due again after interval elapsed"
  );

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn polling_due_selection_rejects_missing_non_positive_and_not_yet_elapsed_intervals() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (_app, pool, auth_store) = helpers::setup_app().await;
  cleanup_git_sync_policy(&pool).await;
  upsert_app_config(&pool, "git_sync.enabled", json!(true)).await;
  upsert_app_config(&pool, "git_sync.auto_sync_allowed", json!(true)).await;
  upsert_app_config(&pool, "git_sync.allowed_hosts", json!(["scheduler-invalid.test"])).await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "git-sync-scheduler-invalid").await;

  let missing = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-invalid.test",
    "missing",
    None,
    false,
  )
  .await;
  let zero = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-invalid.test",
    "zero",
    Some(0),
    false,
  )
  .await;
  let not_elapsed = insert_polling_profile(
    &pool,
    helpers::create_workspace(&pool, owner_id).await,
    owner_id,
    "scheduler-invalid.test",
    "not-elapsed",
    Some(300),
    true,
  )
  .await;
  insert_run(&pool, not_elapsed, "Completed", 130, Some(120)).await;
  for invalid in [missing, zero] {
    let enable = sqlx::query("UPDATE git_sync_profiles SET enabled = true WHERE id = $1")
      .bind(invalid)
      .execute(&pool)
      .await;
    assert!(
      enable.is_err(),
      "the DB invariant must reject enabling Polling without a positive interval"
    );
  }

  let due = due_polling_profiles(&pool, &effective_policy(&pool).await, Utc::now())
    .await
    .expect("due selection");
  let due_ids = due.iter().map(|candidate| candidate.profile_id).collect::<Vec<_>>();
  assert!(!due_ids.contains(&missing), "a missing interval must never schedule");
  assert!(!due_ids.contains(&zero), "a non-positive interval must never schedule");
  assert!(
    !due_ids.contains(&not_elapsed),
    "a 300-second interval must not schedule after only 120 seconds"
  );

  cleanup_git_sync_policy(&pool).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
