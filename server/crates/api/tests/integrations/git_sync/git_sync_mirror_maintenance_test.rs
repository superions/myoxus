//! Production-shaped Git-Sync mirror maintenance invariants.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_api::git_sync_engine::locking;
use myoxus_api::git_sync_engine::maintenance::GitSyncMaintenance;
use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::git_sync::{
  SqlxGitSyncStore, StagingOwnership, acquire_profile_mirror, create_staged_mirror,
};
use myoxus_infrastructure::redis::RedisAdapter;
use myoxus_infrastructure::redis_lease::RedisLease;

use crate::helpers;

async fn seed_profile(pool: &sqlx::PgPool, workspace_id: Uuid, owner_id: Uuid, enabled: bool) -> Uuid {
  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path,
        sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, $4, 'main', 'content/',
             'Bidirectional', 'Manual', 'HttpsToken', $5)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .bind(format!("https://example.invalid/{profile_id}.git"))
  .bind(enabled)
  .execute(pool)
  .await
  .expect("seed Git-Sync profile");
  profile_id
}

#[tokio::test]
async fn sql_history_cleanup_preserves_live_children_and_recovery_without_a_mirror() {
  use futures_util::FutureExt;
  let (_, pool, auth) = helpers::setup_app().await;
  let (actor, _) = helpers::seed_admin(&pool, &auth).await;
  let workspace = helpers::create_workspace(&pool, actor).await;
  let result = std::panic::AssertUnwindSafe(async {
    let profile = seed_profile(&pool, workspace, actor, false).await;
    let store = SqlxGitSyncStore::new(pool.clone());
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO git_sync_runs(id,profile_id,direction,status,started_at,finished_at,commit_after,observed_remote_oid)
      VALUES($1,$2,'Bidirectional','Completed',now()-interval '40 days',now()-interval '30 days',repeat('a',40),repeat('a',40))")
      .bind(run).bind(profile).execute(&pool).await.unwrap();
    let old_conflict = Uuid::new_v4();
    let open_conflict = Uuid::new_v4();
    let null_closed = Uuid::new_v4();
    let new_closed = Uuid::new_v4();
    for (id,resolution,age) in [(old_conflict,"Dismissed",Some(20)),(open_conflict,"Open",None),
      (null_closed,"Dismissed",None),(new_closed,"Dismissed",Some(1))] {
      sqlx::query("INSERT INTO git_sync_conflicts(id,profile_id,doc_id,repo_path,conflict_type,resolution,resolved_at)
        VALUES($1,$2,$1,$1::text,'BothModified',$3,now()-make_interval(days=>$4))")
        .bind(id).bind(profile).bind(resolution).bind(age).execute(&pool).await.unwrap();
    }
    let old_file = Uuid::new_v4();
    let new_file = Uuid::new_v4();
    for (id,age) in [(old_file,20),(new_file,1)] {
      sqlx::query("INSERT INTO git_sync_file_conflicts(id,profile_id,run_id,repo_path,resolution,resolved_at)
        VALUES($1,$2,$3,$1::text,'Dismissed',now()-make_interval(days=>$4))")
        .bind(id).bind(profile).bind(run).bind(age).execute(&pool).await.unwrap();
    }
    let empty_session = Uuid::new_v4();
    let recent_child_session = Uuid::new_v4();
    let open_session = Uuid::new_v4();
    for (id,status) in [(empty_session,"Completed"),(recent_child_session,"CompletedWithFailures"),(open_session,"Open")] {
      sqlx::query("INSERT INTO git_sync_partial_sessions(id,profile_id,direction,status,created_run_id,updated_at)
        VALUES($1,$2,'Bidirectional',$3,$4,now()-interval '20 days')")
        .bind(id).bind(profile).bind(status).bind(run).execute(&pool).await.unwrap();
    }
    let old_item = Uuid::new_v4();
    let recent_item = Uuid::new_v4();
    let open_item = Uuid::new_v4();
    for (id,session,age) in [(old_item,empty_session,20),(recent_item,recent_child_session,1),(open_item,open_session,20)] {
      sqlx::query("INSERT INTO git_sync_partial_items(id,session_id,profile_id,item_kind,item_key,repo_path,sort_key,status,last_run_id,updated_at)
        VALUES($1,$2,$3,'GitMarkdown',$1::text,$1::text,$1::text,'Completed',$4,now()-make_interval(days=>$5))")
        .bind(id).bind(session).bind(profile).bind(run).bind(age).execute(&pool).await.unwrap();
    }
    let attempt = Uuid::new_v4();
    sqlx::query("INSERT INTO git_sync_bootstrap_attempts(id,profile_id,phase,expected_remote_oid,desired_tree_fingerprint,report,updated_at)
      VALUES($1,$2,'Failed','a','b','{}',now()-interval '20 days')")
      .bind(attempt).bind(profile).execute(&pool).await.unwrap();
    let rejected = Uuid::new_v4();
    let assigned = Uuid::new_v4();
    let pending = Uuid::new_v4();
    for (id,accepted,linked,reason) in [(rejected,false,None,Some("branch mismatch")),(assigned,true,Some(run),None),(pending,true,None,None)] {
      sqlx::query("INSERT INTO git_sync_webhook_deliveries(id,profile_id,dedupe_key,payload_hash,accepted,run_id,rejection_reason,received_at)
        VALUES($1,$2,$1::text,'hash',$3,$4,$5,now()-interval '20 days')")
        .bind(id).bind(profile).bind(accepted).bind(linked).bind(reason).execute(&pool).await.unwrap();
    }
    let doc=helpers::create_doc(&pool,workspace,actor).await;
    let mut histories=Vec::new();
    for (linked,discarded,age) in [(None,true,20),(Some(run),false,20),(None,false,20),(Some(run),false,1)] {
      let history:i64=sqlx::query_scalar("INSERT INTO doc_histories(doc_id,workspace_id,snapshot) VALUES($1,$2,'\\x0000') RETURNING id")
        .bind(doc).bind(workspace).fetch_one(&pool).await.unwrap();
      sqlx::query("INSERT INTO git_sync_history_capture_receipts(profile_id,history_id,workspace_id,activation_generation,
        assigned_run_id,assigned_at,discarded_at,created_at)
        VALUES($1,$2,$3,1,$4,CASE WHEN $4::uuid IS NOT NULL THEN now()-make_interval(days=>$6) END,
          CASE WHEN $5 THEN now()-make_interval(days=>$6) END,now()-interval '20 days')")
        .bind(profile).bind(history).bind(workspace).bind(linked).bind(discarded).bind(age).execute(&pool).await.unwrap();
      histories.push(history);
    }
    let cutoff = store.history_retention_cutoff(7).await.unwrap();
    let first = store.cleanup_auxiliary_history(profile,cutoff,1_000).await.unwrap();
    assert_eq!(first.deleted_rows(),9,"only expired final state and explicitly deleted children expire: {first:?}");
    let captures:Vec<i64>=sqlx::query_scalar("SELECT history_id FROM git_sync_history_capture_receipts WHERE profile_id=$1 ORDER BY history_id")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(captures,vec![histories[2],histories[3]],"pending intent and newer assignment survive");
    let policy=myoxus_api::git_sync_engine::policy::resolve_git_sync_policy(
      &Default::default(),&Default::default()).unwrap().lifecycle_policy();
    assert!(store.admit_history_capture(profile,histories[0],1,&policy).await.unwrap().is_none(),
      "a delayed expired receipt does not reconstruct intent");
    let conflicts:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM git_sync_conflicts WHERE profile_id=$1")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(conflicts.len(),3);
    for id in [open_conflict,null_closed,new_closed] { assert!(conflicts.contains(&id)); }
    let files:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM git_sync_file_conflicts WHERE profile_id=$1")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(files,vec![new_file]);
    let sessions:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM git_sync_partial_sessions WHERE profile_id=$1")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(sessions.len(),2);
    assert!(sessions.contains(&open_session) && sessions.contains(&recent_child_session));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM git_sync_partial_items WHERE profile_id=$1")
      .bind(profile).fetch_one(&pool).await.unwrap(),2);
    let deliveries:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM git_sync_webhook_deliveries WHERE profile_id=$1")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(deliveries,vec![pending],"accepted unassigned intent has no age expiry");
    assert_eq!(store.cleanup_auxiliary_history(profile,cutoff,1_000).await.unwrap().deleted_rows(),0);
    // Newer children of an old parent must not disappear through CASCADE or
    // SET NULL. The newest summary wins the deterministic timestamp/UUID tie.
    let mut tied=[Uuid::new_v4(),Uuid::new_v4()];tied.sort();
    let [tie_loser,newest]=tied;
    let deletable=Uuid::new_v4();
    let newer_provenance=Uuid::new_v4();
    let null_finished=Uuid::new_v4();
    let tied_at=Utc::now()-Duration::days(15);
    for (id,status,finished) in [(tie_loser,"Failed",true),(newest,"Cancelled",true),
      (deletable,"Completed",true),(newer_provenance,"Completed",true),(null_finished,"Failed",false)] {
      sqlx::query("INSERT INTO git_sync_runs(id,profile_id,direction,status,started_at,finished_at,commit_after,observed_remote_oid)
        VALUES($1,$2,'Bidirectional',$3,$4,CASE WHEN $5 THEN $4 ELSE NULL END,CASE WHEN $3='Completed' THEN repeat('a',40) END,repeat('a',40))")
        .bind(id).bind(profile).bind(status)
        .bind(if id==newest || id==tie_loser {tied_at} else {tied_at-Duration::days(1)})
        .bind(finished).execute(&pool).await.unwrap();
    }
    for (parent,age) in [(newest,20),(deletable,20),(newer_provenance,1)] {
      sqlx::query("INSERT INTO git_sync_version_links(profile_id,run_id,sync_object_kind,sync_object_id,direction,repo_path,created_at)
        VALUES($1,$2,'doc','retention','push','retention.md',now()-make_interval(days=>$3))")
        .bind(profile).bind(parent).bind(age).execute(&pool).await.unwrap();
    }
    let expired=store.cleanup_terminal_runs(profile,cutoff,1_000).await.unwrap();
    assert_eq!(expired.deleted.get("versionLinks"),Some(&2));
    assert_eq!(expired.deleted.get("runs"),Some(&2));
    let retained:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM git_sync_runs WHERE profile_id=$1")
      .bind(profile).fetch_all(&pool).await.unwrap();
    assert_eq!(retained.len(),4);
    for id in [run,newest,newer_provenance,null_finished] {assert!(retained.contains(&id));}
    assert_eq!(store.cleanup_terminal_runs(profile,cutoff,1_000).await.unwrap().deleted_rows(),0);
    let skipped=myoxus_api::git_sync_engine::runner::run_sync(&pool,&Default::default(),&locking::new_locks(),
      &myoxus_application::ports::NullBlobStorage,profile,deletable,"late-delivery",
      myoxus_domain::git_sync::SyncDirection::Bidirectional,myoxus_domain::git_sync::GitSyncRunSource::Manual).await.unwrap();
    assert_eq!(skipped["reason"],"run_missing","a deleted ID must not reach unavailable credentials or the network");
    let nightly_run=Uuid::new_v4();
    sqlx::query("INSERT INTO git_sync_runs(id,profile_id,direction,status,started_at,finished_at)
      VALUES($1,$2,'Bidirectional','Failed',now()-interval '25 days',now()-interval '24 days')")
      .bind(nightly_run).bind(profile).execute(&pool).await.unwrap();
    let nightly_conflict=Uuid::new_v4();
    sqlx::query("INSERT INTO git_sync_conflicts(id,profile_id,doc_id,repo_path,conflict_type,resolution,resolved_at)
      VALUES($1,$2,$1,$1::text,'BothModified','Dismissed',now()-interval '20 days')")
      .bind(nightly_conflict).bind(profile).execute(&pool).await.unwrap();
    let directory=tempfile::tempdir().unwrap();
    let redis:Arc<dyn RedisPort>=Arc::new(myoxus_infrastructure::redis::InMemoryRedisAdapter::new("sql-history"));
    let maintenance=GitSyncMaintenance::new(SqlxGitSyncStore::new(pool.clone()),directory.path().to_path_buf(),locking::new_locks(),redis,60);
    let wired=maintenance.cleanup_with_retention(7).await.unwrap();
    assert!(wired.sql_history.deleted.get("runs").copied().unwrap_or_default()>=1);
    assert!(!wired.sql_history.budget_exhausted);
    assert!(matches!(store.get_run(nightly_run).await,Err(myoxus_infrastructure::git_sync::GitSyncStoreError::NotFound)));
    assert!(matches!(store.get_conflict(nightly_conflict).await,Err(myoxus_infrastructure::git_sync::GitSyncStoreError::NotFound)));
    assert_eq!(maintenance.cleanup_with_retention(7).await.unwrap().sql_history.deleted.values().sum::<u64>(),0);
    sqlx::query("INSERT INTO git_sync_conflicts(profile_id,doc_id,repo_path,conflict_type,resolution,resolved_at)
      SELECT $1,gen_random_uuid(),'batch-'||i,'BothModified','Dismissed',now()-interval '20 days' FROM generate_series(1,1001) i")
      .bind(profile).execute(&pool).await.unwrap();
    assert_eq!(store.cleanup_auxiliary_history(profile,cutoff,1_000).await.unwrap().deleted_rows(),1_000,
      "one transaction never consumes more than the fixed batch budget");
    assert_eq!(maintenance.cleanup_with_retention(7).await.unwrap().sql_history.deleted.get("documentConflicts"),Some(&1));
    sqlx::query("UPDATE git_sync_runs SET reconciliation_required=true,reconciliation_reason='retention recovery fixture' WHERE id=$1")
      .bind(null_finished).execute(&pool).await.unwrap();
    assert_eq!(store.cleanup_terminal_runs(profile,cutoff,1_000).await.unwrap().protected_profiles,1);
    sqlx::query("UPDATE git_sync_runs SET reconciliation_required=false,reconciliation_reason=NULL WHERE id=$1")
      .bind(null_finished).execute(&pool).await.unwrap();
    // An uncertain external outcome protects all profile history until recovery,
    // even when no mirror exists and the profile is disabled.
    sqlx::query("INSERT INTO git_sync_bootstrap_attempts(id,profile_id,phase,expected_remote_oid,observed_remote_oid,desired_tree_fingerprint,report)
      VALUES($1,$2,'Failed','a','b','c','{}')")
      .bind(Uuid::new_v4()).bind(profile).execute(&pool).await.unwrap();
    assert_eq!(store.cleanup_auxiliary_history(profile,cutoff,1_000).await.unwrap().protected_profiles,1);
    let mut lock=pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM git_sync_profiles WHERE id=$1 FOR UPDATE").bind(profile).execute(&mut *lock).await.unwrap();
    assert_eq!(store.cleanup_auxiliary_history(profile,cutoff,1_000).await.unwrap().busy_profiles,1);
    lock.rollback().await.unwrap();
  }).catch_unwind().await;
  helpers::cleanup_users(&pool, &[actor]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

fn canonical(repo_base: &Path, profile_id: Uuid, content: &str) -> PathBuf {
  let path = repo_base.join(profile_id.to_string());
  std::fs::create_dir_all(&path).expect("canonical fixture");
  std::fs::write(path.join("evidence.txt"), content).expect("canonical evidence");
  path
}

async fn staging(repo_base: &Path, profile_id: Uuid, created_at: chrono::DateTime<Utc>, content: &str) -> PathBuf {
  let staged = create_staged_mirror(repo_base, profile_id, Uuid::new_v4())
    .await
    .expect("staging fixture");
  std::fs::create_dir(staged.repository_path()).expect("staged repository fixture");
  std::fs::write(staged.repository_path().join("evidence.txt"), content).expect("staged evidence");
  let ownership = StagingOwnership {
    created_at,
    ..staged.ownership().clone()
  };
  std::fs::write(
    staged.metadata_path(),
    serde_json::to_vec(&ownership).expect("serialize adjusted staging ownership"),
  )
  .expect("adjust staging ownership");
  staged.root_path().to_path_buf()
}

#[cfg(unix)]
#[tokio::test]
async fn disabled_profiles_and_unverified_paths_survive_while_only_proven_orphans_expire() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let enabled_workspace = helpers::create_workspace(&pool, admin_id).await;
  let disabled_workspace = helpers::create_workspace(&pool, admin_id).await;
  let running_workspace = helpers::create_workspace(&pool, admin_id).await;
  let enabled_profile = seed_profile(&pool, enabled_workspace, admin_id, true).await;
  let disabled_profile = seed_profile(&pool, disabled_workspace, admin_id, false).await;
  let running_profile = seed_profile(&pool, running_workspace, admin_id, true).await;
  sqlx::query(
    "INSERT INTO git_sync_runs (id, profile_id, direction, status, job_id)
     VALUES ($1, $2, 'Bidirectional', 'Running', $3)",
  )
  .bind(Uuid::new_v4())
  .bind(running_profile)
  .bind(format!("git-sync-maintenance-{running_profile}"))
  .execute(&pool)
  .await
  .expect("unfinished run fixture");

  let temp = tempfile::tempdir().expect("mirror tempdir");
  let repo_base = temp.path().join("mirrors");
  std::fs::create_dir(&repo_base).expect("mirror base");
  let enabled_path = canonical(&repo_base, enabled_profile, "enabled owner");
  let disabled_path = canonical(&repo_base, disabled_profile, "disabled owner");
  let orphan_profile = Uuid::new_v4();
  let orphan_path = canonical(&repo_base, orphan_profile, "orphan");
  let busy_profile = Uuid::new_v4();
  let busy_path = canonical(&repo_base, busy_profile, "busy orphan");
  let native_busy_profile = Uuid::new_v4();
  let native_busy_path = canonical(&repo_base, native_busy_profile, "native busy orphan");
  let native_busy_guard = acquire_profile_mirror(&repo_base, native_busy_profile)
    .await
    .expect("native busy fixture");
  let unknown_path = repo_base.join("operator-backup");
  std::fs::create_dir(&unknown_path).expect("unknown path");
  std::fs::write(unknown_path.join("evidence.txt"), "unknown").expect("unknown evidence");

  let now = Utc::now();
  let expired_staging = staging(&repo_base, disabled_profile, now - Duration::hours(25), "expired").await;
  let current_staging = staging(&repo_base, disabled_profile, now - Duration::hours(1), "current").await;
  let unfinished_staging = staging(&repo_base, running_profile, now - Duration::hours(25), "unfinished").await;

  let redis_url = std::env::var("TEST_REDIS_URL").expect("TEST_REDIS_URL");
  let redis: Arc<dyn RedisPort> = Arc::new(
    RedisAdapter::new(redis_url, format!("git-sync-maintenance-{}", Uuid::new_v4())).expect("test Redis adapter"),
  );
  let busy_lease = RedisLease::acquire(redis.clone(), format!("git-sync:lock:{busy_profile}"), 60)
    .await
    .expect("busy lease transport")
    .expect("busy lease");
  let maintenance = GitSyncMaintenance::new(
    SqlxGitSyncStore::new(pool.clone()),
    repo_base.clone(),
    locking::new_locks(),
    redis.clone(),
    60,
  );

  let first = maintenance.cleanup().await.expect("first cleanup");
  assert_eq!(first.cleaned_canonical_mirrors, 1);
  assert_eq!(first.cleaned_staging, 1);
  assert_eq!(first.retained_existing_mirrors, 2);
  assert_eq!(first.retained_current_staging, 1);
  assert_eq!(first.retained_unfinished_staging, 1);
  assert_eq!(first.retained_busy_candidates, 2);
  assert_eq!(first.retained_unknown_entries, 1);
  assert!(!orphan_path.exists());
  assert!(!expired_staging.exists());
  assert_eq!(
    std::fs::read_to_string(enabled_path.join("evidence.txt")).expect("enabled evidence"),
    "enabled owner"
  );
  assert_eq!(
    std::fs::read_to_string(disabled_path.join("evidence.txt")).expect("disabled evidence"),
    "disabled owner"
  );
  assert_eq!(
    std::fs::read_to_string(busy_path.join("evidence.txt")).expect("busy evidence"),
    "busy orphan"
  );
  assert_eq!(
    std::fs::read_to_string(native_busy_path.join("evidence.txt")).expect("native busy evidence"),
    "native busy orphan"
  );
  assert_eq!(
    std::fs::read_to_string(current_staging.join("mirror/evidence.txt")).expect("current evidence"),
    "current"
  );
  assert_eq!(
    std::fs::read_to_string(unfinished_staging.join("mirror/evidence.txt")).expect("unfinished evidence"),
    "unfinished"
  );
  assert_eq!(
    std::fs::read_to_string(unknown_path.join("evidence.txt")).expect("unknown evidence"),
    "unknown"
  );

  drop(busy_lease);
  drop(native_busy_guard);
  for _ in 0..50 {
    let busy_released = redis
      .get_string(&format!("git-sync:lock:{busy_profile}"))
      .await
      .expect("inspect released busy lease")
      .is_none();
    let native_released = redis
      .get_string(&format!("git-sync:lock:{native_busy_profile}"))
      .await
      .expect("inspect released native-busy lease")
      .is_none();
    if busy_released && native_released {
      break;
    }
    tokio::time::sleep(StdDuration::from_millis(10)).await;
  }
  let second = maintenance.cleanup().await.expect("second cleanup");
  assert_eq!(second.cleaned_canonical_mirrors, 2);
  assert!(!busy_path.exists());
  assert!(!native_busy_path.exists());
  let third = maintenance.cleanup().await.expect("idempotent cleanup");
  assert_eq!(third.cleaned_canonical_mirrors, 0);
  assert_eq!(third.cleaned_staging, 0);

  let database_failure_base = temp.path().join("database-failure");
  std::fs::create_dir(&database_failure_base).expect("database failure base");
  let database_failure_path = canonical(&database_failure_base, Uuid::new_v4(), "database failure evidence");
  let closed_pool = sqlx::postgres::PgPoolOptions::new()
    .connect_lazy("postgres://closed:closed@127.0.0.1:1/closed")
    .expect("closed lazy pool");
  closed_pool.close().await;
  let failed = GitSyncMaintenance::new(
    SqlxGitSyncStore::new(closed_pool),
    database_failure_base,
    locking::new_locks(),
    redis.clone(),
    60,
  );
  assert!(failed.cleanup().await.is_err());
  assert_eq!(
    std::fs::read_to_string(database_failure_path.join("evidence.txt")).expect("database failure evidence"),
    "database failure evidence"
  );

  let symlink_base = temp.path().join("symlink");
  std::fs::create_dir(&symlink_base).expect("symlink base");
  let outside = temp.path().join("outside");
  std::fs::create_dir(&outside).expect("outside fixture");
  std::fs::write(outside.join("evidence.txt"), "outside").expect("outside evidence");
  std::os::unix::fs::symlink(&outside, symlink_base.join(Uuid::new_v4().to_string())).expect("escape symlink");
  let symlink_maintenance = GitSyncMaintenance::new(
    SqlxGitSyncStore::new(pool.clone()),
    symlink_base,
    locking::new_locks(),
    redis,
    60,
  );
  assert!(symlink_maintenance.cleanup().await.is_err());
  assert_eq!(
    std::fs::read_to_string(outside.join("evidence.txt")).expect("outside evidence"),
    "outside"
  );

  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(vec![enabled_workspace, disabled_workspace, running_workspace])
    .execute(&pool)
    .await
    .expect("cleanup workspace fixture");
}
