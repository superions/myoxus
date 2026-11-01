//! P83 — Invariant-first integration tests: Git Sync domain.
//!
//! Each test maps to a named invariant (INV-GS-*).
//!
//! Tests verify DB STATE after operations, not just HTTP / GraphQL responses.
//! Naming convention: `inv_{code}_{description}`.
//!
//! Note: actual sync execution (cloning, pushing) is NOT tested here.
//! Tests focus on profile CRUD and run record management.

use crate::helpers;

use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use myoxus_api::git_sync_engine::dispatch::{dispatch_pending_runs, dispatch_run, pending_dispatch};
use myoxus_domain::git_sync::{GitSyncRunSource, SyncDirection};
use myoxus_infrastructure::git_sync::{GitSyncStoreError, SqlxGitSyncStore};
use myoxus_worker::{JobOptions, RedisQueue};

// ---------------------------------------------------------------------------
// INV-GS-02 — A sync run record is stored in git_sync_runs with correct profile_id
//
// Insert a profile directly, then insert a run record.
// Assert: the run row exists with the correct profile_id and an initial status.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gs02_sync_run_recorded() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs02_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Insert profile directly (bypass policy for a pure DB-state test)
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert profile");

  // Insert a run record (mimics what the sync engine writes after a run)
  let run_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_runs (id, profile_id, direction, status) VALUES ($1, $2, 'MyoxusToGit', 'Pending')",
  )
  .bind(run_id)
  .bind(profile_id)
  .execute(&pool)
  .await
  .expect("insert run record");

  // Assert: run row exists with the correct profile_id and status
  let row = sqlx::query("SELECT profile_id, status FROM git_sync_runs WHERE id = $1")
    .bind(run_id)
    .fetch_optional(&pool)
    .await
    .expect("git_sync_runs query");

  let row = row.expect("INV-GS-02: run record must exist after insert");
  assert_eq!(
    row.get::<Uuid, _>("profile_id"),
    profile_id,
    "INV-GS-02: run profile_id must match the owning profile"
  );
  assert_eq!(
    row.get::<String, _>("status"),
    "Pending",
    "INV-GS-02: initial run status must be 'Pending'"
  );

  // Cleanup: cascade via workspace delete
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-GS-03 — Deleting a profile cascades to git_sync_runs
//
// Create a profile and a run record, then delete the profile.
// Assert: the run rows are also gone (ON DELETE CASCADE).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gs03_profile_deletion_cascades_to_runs() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs03_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // Insert profile
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert profile");

  // One valid unfinished run is sufficient to prove the foreign-key cascade.
  // Creating a second unfinished run would violate admission, while fabricating
  // a terminal run without its verified terminal revision would bypass the
  // lifecycle contract this test is not intended to exercise.
  sqlx::query(
    "INSERT INTO git_sync_runs (id, profile_id, direction, status) VALUES ($1, $2, 'MyoxusToGit', 'Pending')",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .execute(&pool)
  .await
  .expect("insert run");

  // Verify pre-condition: runs exist
  let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("count before");
  assert_eq!(count_before, 1, "INV-GS-03 pre: the run record must exist");

  // Delete profile
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .expect("delete profile");

  // Assert: run records are cascaded
  let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_runs WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("count after");
  assert_eq!(
    count_after, 0,
    "INV-GS-03: deleting a profile must cascade-delete all associated git_sync_runs"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-GS-04 — Concurrent ingress admits one unfinished run per profile.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gs04_concurrent_run_admission_reuses_one_unfinished_run() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs04_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/',
             'MyoxusToGit', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert profile");
  let store = SqlxGitSyncStore::new(pool.clone());

  let (first, second) = tokio::join!(
    store.create_pending_run_if_absent(profile_id, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual),
    store.create_pending_run_if_absent(profile_id, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual),
  );
  let (first, first_inserted) = first.expect("first concurrent admission");
  let (second, second_inserted) = second.expect("second concurrent admission");

  assert_eq!(
    first.id, second.id,
    "both ingress calls must resolve to one durable intent"
  );
  assert_ne!(
    first_inserted, second_inserted,
    "exactly one concurrent ingress must own insertion"
  );
  let unfinished: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM git_sync_runs WHERE profile_id = $1 AND status IN ('Pending', 'Running')",
  )
  .bind(profile_id)
  .fetch_one(&pool)
  .await
  .expect("unfinished run count");
  assert_eq!(unfinished, 1, "the DB invariant must reject duplicate unfinished runs");

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_gs04_changed_profile_contract_never_reuses_stale_intent() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs04_contract_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/',
             'MyoxusToGit', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert profile");
  let store = SqlxGitSyncStore::new(pool.clone());
  let (stale_run, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual)
    .await
    .expect("create original intent");
  assert!(inserted);

  sqlx::query(
    "UPDATE git_sync_profiles
        SET sync_direction = 'GitToMyoxus', trigger_mode = 'Webhook'
      WHERE id = $1",
  )
  .bind(profile_id)
  .execute(&pool)
  .await
  .expect("change profile contract");

  let error = store
    .create_pending_run_if_absent(profile_id, SyncDirection::GitToMyoxus, GitSyncRunSource::Webhook)
    .await
    .expect_err("a changed profile contract must not adopt stale unfinished work");
  assert!(
    matches!(error, GitSyncStoreError::UnfinishedRunConflict { .. }),
    "the admission failure must explain the stale contract: {error}"
  );
  let unfinished: Vec<(Uuid, String, String)> = sqlx::query_as(
    "SELECT id, direction, trigger_source
       FROM git_sync_runs
      WHERE profile_id = $1 AND status IN ('Pending', 'Running')",
  )
  .bind(profile_id)
  .fetch_all(&pool)
  .await
  .expect("load unfinished intents");
  assert_eq!(
    unfinished,
    vec![(stale_run.id, "MyoxusToGit".to_string(), "Manual".to_string())],
    "failed admission must preserve the existing durable intent without creating a second run"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// INV-GS-05 — DB intent survives Redis failure and replay claims once.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_gs05_pending_dispatch_recovers_after_redis_failure_without_double_claim() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs05_owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/',
             'MyoxusToGit', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert profile");
  let store = SqlxGitSyncStore::new(pool.clone());
  let (run, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual)
    .await
    .expect("create durable intent");
  assert!(inserted);

  let unavailable = RedisQueue::new(
    "redis://127.0.0.1:1",
    format!("git-sync-unavailable-{}", Uuid::new_v4().as_simple()),
  )
  .expect("construct unavailable Redis queue");
  let failure = dispatch_run(&unavailable, &store, pending_dispatch(run.clone()))
    .await
    .expect_err("Redis outage must be reported");
  assert!(failure.contains("enqueue Git-Sync run"));
  let persisted = store.get_run(run.id).await.expect("reload recoverable intent");
  let job_id = persisted
    .job_id
    .clone()
    .expect("job id must be durable before Redis publication");
  assert_eq!(persisted.status.to_string(), "Pending");

  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue = RedisQueue::new(&redis_url, format!("git-sync-recovery-{}", Uuid::new_v4().as_simple()))
    .expect("recovery Redis queue");
  let restarted_store = SqlxGitSyncStore::new(pool.clone());
  let first_pass = dispatch_pending_runs(&queue, &restarted_store, 100)
    .await
    .expect("dispatch after restart");
  assert_eq!(first_pass.acknowledged, 1);
  assert!(first_pass.failures.is_empty());
  let replay_pass = dispatch_pending_runs(&queue, &restarted_store, 100)
    .await
    .expect("idempotent dispatch replay");
  assert_eq!(replay_pass.acknowledged, 1);
  assert!(replay_pass.failures.is_empty());
  let (_, waiting) = queue
    .list_jobs("git-sync", "waiting", 0, 10)
    .await
    .expect("waiting jobs after replay");
  assert_eq!(waiting, 1, "publish replay must leave exactly one queue delivery");

  let first_claim = restarted_store
    .claim_pending_run(
      run.id,
      profile_id,
      SyncDirection::MyoxusToGit,
      GitSyncRunSource::Manual,
      &job_id,
    )
    .await
    .expect("first worker claim");
  assert!(first_claim.is_some(), "first matching worker must claim the run");
  let duplicate_claim = restarted_store
    .claim_pending_run(
      run.id,
      profile_id,
      SyncDirection::MyoxusToGit,
      GitSyncRunSource::Manual,
      &job_id,
    )
    .await
    .expect("duplicate worker claim");
  assert!(
    duplicate_claim.is_none(),
    "replayed delivery must not claim an already Running intent"
  );

  queue.empty_queue("git-sync").await.expect("clean recovery test queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_gs05_poisoned_delivery_does_not_starve_later_pending_runs() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _) = helpers::seed_user(&pool, &auth_store, "inv_gs05_batch_owner").await;
  let first_workspace = helpers::create_workspace(&pool, owner_id).await;
  let second_workspace = helpers::create_workspace(&pool, owner_id).await;
  let first_profile = Uuid::new_v4();
  let second_profile = Uuid::new_v4();
  for (profile_id, workspace_id) in [(first_profile, first_workspace), (second_profile, second_workspace)] {
    sqlx::query(
      "INSERT INTO git_sync_profiles
         (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
          trigger_mode, auth_method, enabled)
       VALUES ($1, $2, $3, 'https://localhost/repo.git', 'main', 'content/',
               'MyoxusToGit', 'Manual', 'HttpsToken', true)",
    )
    .bind(profile_id)
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("insert profile");
  }
  let store = SqlxGitSyncStore::new(pool.clone());
  let (first_run, _) = store
    .create_pending_run_if_absent(first_profile, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual)
    .await
    .expect("create first intent");
  let (second_run, _) = store
    .create_pending_run_if_absent(second_profile, SyncDirection::MyoxusToGit, GitSyncRunSource::Manual)
    .await
    .expect("create second intent");

  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue =
    RedisQueue::new(&redis_url, format!("git-sync-batch-{}", Uuid::new_v4().as_simple())).expect("batch Redis queue");
  let first_job_id = format!("git-sync-{}", first_run.id);
  store
    .persist_dispatch_job_id(first_run.id, &first_job_id)
    .await
    .expect("persist first job id");
  queue
    .enqueue_idempotent(
      "git-sync",
      &first_job_id,
      "git-sync.syncRun",
      json!({"runId": "poisoned"}),
      JobOptions::default(),
    )
    .await
    .expect("create mismatched delivery");

  let pass = dispatch_pending_runs(&queue, &store, 100)
    .await
    .expect("dispatcher pass");
  assert_eq!(pass.attempted, 2);
  assert_eq!(pass.acknowledged, 1, "the valid later intent must still be published");
  assert_eq!(pass.failures.len(), 1, "the poisoned intent must remain explicit");
  let second_job_id = format!("git-sync-{}", second_run.id);
  let second_delivery = queue
    .get_job("git-sync", &second_job_id)
    .await
    .expect("load second delivery");
  assert!(
    second_delivery.is_some(),
    "a prior idempotency conflict must not starve a later Pending run"
  );

  queue.empty_queue("git-sync").await.expect("clean batch queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
