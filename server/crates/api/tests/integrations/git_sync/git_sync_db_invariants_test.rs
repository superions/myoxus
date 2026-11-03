//! Git Sync DB-level invariant tests.
//!
//! Verifies FK cascades, unique constraints, and status invariants directly
//! against a real Postgres instance. Requires TEST_DATABASE_URL.

use crate::helpers;

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use myoxus_application::admin::AdminStore;
use myoxus_application::doc::{InitialDocumentProvenance, InitialDocumentProvenanceMode};
use myoxus_application::git_sync::finalization::{GitSyncPostPushPlan, PreparedDocumentUpsert};
use myoxus_application::git_sync::{
  EncryptedGitCredential, GitSyncBindingAdoption, GitSyncLifecycleStore, GitSyncReconciliationCounts,
  GitSyncReconciliationDocumentIdentity, GitSyncReconciliationPlan, GitSyncReconciliationReport,
  GitSyncReconciliationStore, GitTokenRotationConfiguration, GitTokenRotationProviderKind, GitTokenRotationState,
  GitTokenRotationStore, GitTokenRotationStoreError,
};
use myoxus_application::workspace_content_operation::WorkspaceContentOperationRepository;
use myoxus_domain::git_sync::{GitSyncBaseline, GitSyncBinding, GitSyncRunSource, RunStatus, SyncDirection};
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentOperationKind, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
};
use myoxus_infrastructure::{
  admin::SqlxAdminStore, git_sync::SqlxGitSyncStore, workspace_content_operation::PgWorkspaceContentOperationRepository,
};

async fn admit_shared_rotation(
  pool: &sqlx::PgPool,
  store: &SqlxGitSyncStore,
  credential: Uuid,
  now: chrono::DateTime<Utc>,
) -> myoxus_application::git_sync::GitTokenRotationAdmission {
  let (generation, revision): (i64, i64) =
    sqlx::query_as("SELECT generation,revision FROM scheduling_schedules WHERE id=$1")
      .bind(credential)
      .fetch_one(pool)
      .await
      .expect("current native rotation clock");
  let attempt = store
    .admit_rotation_slot(
      credential,
      generation,
      revision,
      now,
      &[GitTokenRotationProviderKind::GitLab],
    )
    .await
    .expect("shared native rotation admission")
    .expect("one eligible automatic attempt");
  GitTokenRotationStore::admitted(store, attempt.profile_id, attempt.attempt_id)
    .await
    .expect("native fenced credential admission")
}

/// Helper: create a workspace + git sync profile directly in DB.
async fn seed_profile(pool: &sqlx::PgPool, admin_id: Uuid) -> (Uuid, Uuid) {
  let ws_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, 'GitSyncTest', false)")
    .bind(ws_id)
    .bind(admin_id)
    .execute(pool)
    .await
    .expect("create workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now()) ON CONFLICT (workspace_id, user_id) DO NOTHING",
  )
  .bind(ws_id)
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("create active Git-Sync owner membership");
  helpers::create_workspace_root_doc(pool, ws_id, admin_id).await;

  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://example.com/repo.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(ws_id)
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("create profile");

  (ws_id, profile_id)
}

/// Helper: create a binding for the profile.
async fn seed_binding(pool: &sqlx::PgPool, profile_id: Uuid, ws_id: Uuid) -> Uuid {
  let binding_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let sync_id = Uuid::new_v4();

  // Need a doc for FK
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'TestDoc')")
    .bind(doc_id)
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("create doc");

  sqlx::query(
    "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path, tombstone)
     VALUES ($1, $2, $3, $4, $5, 'content/test.md', false)",
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .bind(doc_id)
  .bind(sync_id)
  .execute(pool)
  .await
  .expect("create binding");

  binding_id
}

/// Helper: cleanup test data.
async fn cleanup(pool: &sqlx::PgPool, ws_id: Uuid, _admin_id: Uuid) {
  // CASCADE will handle profiles → bindings → conflicts
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .ok();
  // Don't delete admin user — shared by other tests
}

async fn seed_expiring_token(pool: &sqlx::PgPool, profile_id: Uuid) -> Uuid {
  let credential_id: Uuid = sqlx::query_scalar(
    "INSERT INTO git_sync_credentials
       (profile_id, auth_method, label, encrypted_data, expires_at)
     VALUES ($1, 'HttpsToken', 'rotation-test', $2, $3)
     RETURNING id",
  )
  .bind(profile_id)
  .bind(vec![1_u8, 2, 3])
  .bind(Utc::now() + chrono::Duration::days(7))
  .fetch_one(pool)
  .await
  .expect("create expiring token credential");
  sqlx::query("UPDATE git_sync_profiles SET credential_id = $2, updated_at = now() WHERE id = $1")
    .bind(profile_id)
    .bind(credential_id)
    .execute(pool)
    .await
    .expect("activate expiring token credential");
  credential_id
}

fn rotation_configuration(enabled: bool) -> GitTokenRotationConfiguration {
  GitTokenRotationConfiguration {
    provider: GitTokenRotationProviderKind::GitLab,
    enabled,
    renew_before_days: 30,
    requested_lifetime_days: 90,
  }
}

#[tokio::test]
async fn extracted_credential_survives_source_profile_and_workspace_deletion() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let store = SqlxGitSyncStore::new(pool.clone());
  let admin = SqlxAdminStore::new(pool.clone());
  for delete_workspace in [false, true] {
    let (source_workspace, source_id) = seed_profile(&pool, admin_id).await;
    let (target_workspace, target_id) = seed_profile(&pool, admin_id).await;
    let isolated_remote = format!("https://example.com/extracted-scope-{source_workspace}.git");
    sqlx::query("UPDATE git_sync_profiles SET repo_url = $2 WHERE id = ANY($1)")
      .bind(vec![source_id, target_id])
      .bind(&isolated_remote)
      .execute(&pool)
      .await
      .expect("isolate the Extract lineage remote scope");
    let credential_id = seed_expiring_token(&pool, source_id).await;
    let manifest = myoxus_application::git_sync::export::extracted_manifest_path("content/projects/manual")
      .expect("derived child manifest");
    sqlx::query("UPDATE git_sync_profiles SET root_path = $2, manifest_path = $3, enabled = false WHERE id = $1")
      .bind(target_id)
      .bind("content/projects/manual")
      .bind(&manifest)
      .execute(&pool)
      .await
      .expect("configure disabled child scope");
    assert!(store.inherit_extracted_credential(source_id, target_id).await.is_err());
    store
      .add_scope_exclusion(
        source_id,
        "content/projects/manual",
        true,
        Some(target_id),
        Uuid::new_v4(),
        0,
      )
      .await
      .expect("register Extract lineage");
    for profile_id in [source_id, target_id] {
      let profile = store.get_profile(profile_id).await.expect("read fenced profile");
      store
        .assert_profile_scope_unambiguous(&profile)
        .await
        .expect("delegated parent and child have disjoint runtime writer scopes");
    }
    GitTokenRotationStore::configure(&store, source_id, rotation_configuration(true))
      .await
      .expect("configure single renewal");
    if delete_workspace {
      let attempt = GitTokenRotationStore::admit(&store, source_id, Utc::now(), true)
        .await
        .expect("admit unshared rotation")
        .expect("rotation attempt");
      assert!(store.inherit_extracted_credential(source_id, target_id).await.is_err());
      GitTokenRotationStore::record_pre_request_failure(
        &store,
        source_id,
        attempt.attempt_id,
        "request not sent",
        Utc::now(),
      )
      .await
      .expect("settle rotation before inheritance");
    }
    store
      .inherit_extracted_credential(source_id, target_id)
      .await
      .expect("inherit credential without copying it");
    assert!(
      store.delete_credential(credential_id).await.is_err(),
      "a referenced credential cannot be removed directly"
    );
    assert!(
      sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
        .bind(source_id)
        .execute(&pool)
        .await
        .is_err(),
      "an unrehomed profile cascade cannot delete a shared secret"
    );
    let inherited = GitTokenRotationStore::status(&store, target_id)
      .await
      .expect("inherited status")
      .expect("one configuration");
    assert_eq!(inherited.profile_id, source_id);
    assert_eq!(
      GitTokenRotationStore::configure(&store, target_id, rotation_configuration(true))
        .await
        .expect("child configures the inherited lifecycle without a second row")
        .profile_id,
      source_id
    );
    let configurations: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM git_token_rotation WHERE profile_id IN ($1, $2)")
        .bind(source_id)
        .bind(target_id)
        .fetch_one(&pool)
        .await
        .expect("read lineage rotation count");
    assert_eq!(configurations, 1);

    let grandchild = if delete_workspace {
      let (workspace, profile_id) = seed_profile(&pool, admin_id).await;
      let root = "content/projects/manual/notes";
      let manifest = myoxus_application::git_sync::export::extracted_manifest_path(root).expect("grandchild manifest");
      sqlx::query("UPDATE git_sync_profiles SET root_path = $2, manifest_path = $3, repo_url = $4 WHERE id = $1")
        .bind(profile_id)
        .bind(root)
        .bind(&manifest)
        .bind(&isolated_remote)
        .execute(&pool)
        .await
        .expect("configure grandchild scope");
      store
        .add_scope_exclusion(target_id, root, true, Some(profile_id), Uuid::new_v4(), 0)
        .await
        .expect("register descendant fence");
      for candidate in [source_id, target_id, profile_id] {
        let current = store.get_profile(candidate).await.expect("read nested writer scope");
        store
          .assert_profile_scope_unambiguous(&current)
          .await
          .expect("every writer in a fenced three-level delegation remains runnable");
      }
      store
        .inherit_extracted_credential(target_id, profile_id)
        .await
        .expect("inherit from child");
      assert_eq!(
        GitTokenRotationStore::status(&store, profile_id)
          .await
          .expect("grandchild inherited status")
          .expect("one lineage rotation")
          .profile_id,
        source_id
      );
      Some((workspace, profile_id))
    } else {
      None
    };

    if delete_workspace {
      admin
        .delete_workspace(source_workspace)
        .await
        .expect("hard-delete source Workspace");
    } else {
      let source = store
        .get_profile(source_id)
        .await
        .expect("source before manual replacement");
      GitSyncLifecycleStore::update_profile(
        &store,
        source,
        Some(EncryptedGitCredential {
          label: "replacement for source only".into(),
          ciphertext: vec![4, 5, 6],
          expires_at: Some(Utc::now() + chrono::Duration::days(90)),
        }),
      )
      .await
      .expect("detach source while retaining the child's old secret");
      assert_eq!(
        store
          .get_credential(credential_id)
          .await
          .expect("old secret remains")
          .profile_id,
        target_id
      );
      GitSyncLifecycleStore::delete_profile(&store, source_id)
        .await
        .expect("delete source profile through lifecycle");
    }
    let target = store.get_profile(target_id).await.expect("surviving disabled child");
    assert_eq!(target.credential_id, Some(credential_id));
    let credential = store
      .get_credential(credential_id)
      .await
      .expect("surviving encrypted secret");
    let expected_steward = grandchild.map_or(target_id, |(_, id)| target_id.min(id));
    assert_eq!(credential.profile_id, expected_steward);
    assert_eq!(
      store
        .get_credential_encrypted_data(credential_id)
        .await
        .expect("encrypted bytes"),
      vec![1, 2, 3]
    );
    assert_eq!(
      GitTokenRotationStore::status(&store, target_id)
        .await
        .expect("rehomed rotation")
        .expect("rotation row")
        .profile_id,
      expected_steward
    );
    admin
      .delete_workspace(target_workspace)
      .await
      .expect("remove dependent Workspace");
    if let Some((workspace, id)) = grandchild {
      assert_eq!(
        store
          .get_credential(credential_id)
          .await
          .expect("grandchild retains credential")
          .profile_id,
        id
      );
      admin
        .delete_workspace(workspace)
        .await
        .expect("remove final descendant");
    }
    assert!(
      store.get_credential(credential_id).await.is_err(),
      "last-reference removal deletes secret"
    );
    if !delete_workspace {
      admin
        .delete_workspace(source_workspace)
        .await
        .expect("remove empty source Workspace");
    }
  }
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn shared_token_rotation_elects_an_accessible_steward_and_replaces_every_pointer_once() {
  use futures_util::FutureExt;
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (source_workspace, source_id) = seed_profile(&pool, admin_id).await;
  let (target_workspace, target_id) = seed_profile(&pool, admin_id).await;
  let body = std::panic::AssertUnwindSafe(async {
    let store = SqlxGitSyncStore::new(pool.clone());
    let original_credential = seed_expiring_token(&pool, source_id).await;
    let root = "content/projects/manual";
    sqlx::query("UPDATE git_sync_profiles SET root_path = $2, manifest_path = $3 WHERE id = $1")
      .bind(target_id)
      .bind(root)
      .bind(myoxus_application::git_sync::export::extracted_manifest_path(root).expect("child manifest"))
      .execute(&pool)
      .await
      .expect("set child scope");
    store
      .add_scope_exclusion(source_id, root, true, Some(target_id), Uuid::new_v4(), 0)
      .await
      .expect("register child lineage");
    GitTokenRotationStore::configure(&store, source_id, rotation_configuration(true))
      .await
      .expect("one configured rotation");
    store
      .inherit_extracted_credential(source_id, target_id)
      .await
      .expect("inherit token");

    let pending = store
      .create_pending_run_if_absent(target_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
      .await
      .expect("admit dependent run before rotation")
      .0;
    assert!(matches!(
      GitTokenRotationStore::admit(&store, source_id, Utc::now(), true).await,
      Err(GitTokenRotationStoreError::UnfinishedRun)
    ));
    sqlx::query("UPDATE git_sync_runs SET status='Cancelled', finished_at=now() WHERE id=$1")
      .bind(pending.id)
      .execute(&pool)
      .await
      .expect("finish dependent run");
    let content_operations =
      PgWorkspaceContentOperationRepository::new(pool.clone(), helpers::database_starter_catalog());
    let now = Utc::now();
    let blocked_operation = WorkspaceContentOperationRecord {
      id: Uuid::new_v4(),
      idempotency_id: Uuid::new_v4(),
      actor_id: admin_id,
      kind: WorkspaceContentOperationKind::Copy,
      source_workspace_id: source_workspace,
      target_workspace_id: Some(target_workspace),
      status: WorkspaceContentOperationStatus::Draft,
      preview_revision: None,
      manifest_hash: "a".repeat(64),
      error: None,
      diagnostic_instance_id: None,
      created_at: now,
      updated_at: now,
    };
    content_operations
      .create_or_get(blocked_operation.clone())
      .await
      .expect("admit handoff before rotation");
    assert!(matches!(
      GitTokenRotationStore::admit(&store, target_id, Utc::now(), true).await,
      Err(GitTokenRotationStoreError::UnfinishedRun)
    ));
    sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
      .bind(blocked_operation.id)
      .execute(&pool)
      .await
      .expect("finish handoff fixture");
    sqlx::query("UPDATE git_sync_profiles SET enabled = false WHERE id = $1")
      .bind(source_id)
      .execute(&pool)
      .await
      .expect("disable old steward");
    let admission = admit_shared_rotation(&pool, &store, original_credential, Utc::now()).await;
    assert_eq!(admission.profile_id, target_id);
    assert!(
      store
        .create_pending_run_if_absent(source_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
        .await
        .is_err()
    );
    assert!(
      store
        .create_pending_run_if_absent(target_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
        .await
        .is_err()
    );
    assert!(
      GitSyncLifecycleStore::update_profile(
        &store,
        store.get_profile(source_id).await.expect("old steward"),
        Some(EncryptedGitCredential {
          label: "blocked".into(),
          ciphertext: vec![6],
          expires_at: None
        }),
      )
      .await
      .is_err()
    );
    assert!(
      GitSyncLifecycleStore::update_profile(
        &store,
        store.get_profile(target_id).await.expect("rotating descendant"),
        Some(EncryptedGitCredential {
          label: "blocked child".into(),
          ciphertext: vec![7],
          expires_at: None,
        }),
      )
      .await
      .is_err(),
      "a child cannot detach the credential while shared rotation is admitted"
    );
    assert!(
      content_operations
        .create_or_get(blocked_operation.clone())
        .await
        .expect_err("new handoff rejected")
        .to_string()
        .contains("admitted Git-Sync token rotation"),
      "a new Workspace handoff cannot start while a dependent credential rotates"
    );
    let replaced = GitTokenRotationStore::install_replacement(
      &store,
      &admission,
      &EncryptedGitCredential {
        label: "one replacement".into(),
        ciphertext: vec![8, 9],
        expires_at: Some(Utc::now() + chrono::Duration::days(90)),
      },
      Utc::now(),
    )
    .await
    .expect("replace every dependent pointer");
    content_operations
      .create_or_get(blocked_operation.clone())
      .await
      .expect("same valid handoff admits after rotation is reconciled");
    sqlx::query("DELETE FROM workspace_content_operations WHERE id = $1")
      .bind(blocked_operation.id)
      .execute(&pool)
      .await
      .expect("remove test handoff before further rotation checks");
    assert_eq!(replaced.state, GitTokenRotationState::Completed);
    let source = store.get_profile(source_id).await.expect("source after rotation");
    let target = store.get_profile(target_id).await.expect("target after rotation");
    assert_eq!(source.credential_id, target.credential_id);
    assert_ne!(source.credential_id, Some(original_credential));
    assert!(store.get_credential(original_credential).await.is_err());
    assert_eq!(
      GitTokenRotationStore::completion_by_attempt(&store, source_id, admission.attempt_id)
        .await
        .expect("read one completed attempt")
        .expect("completion retained")
        .profile_id,
      target_id
    );
    assert!(
      GitTokenRotationStore::admitted(&store, target_id, admission.attempt_id)
        .await
        .is_err()
    );
    assert!(
      GitTokenRotationStore::install_replacement(
        &store,
        &admission,
        &EncryptedGitCredential {
          label: "replay".into(),
          ciphertext: vec![2],
          expires_at: None
        },
        Utc::now()
      )
      .await
      .is_err()
    );
    assert_eq!(
      store
        .get_profile(source_id)
        .await
        .expect("source after replay")
        .credential_id,
      source.credential_id
    );

    let mut reenabled = store.get_profile(source_id).await.expect("source for reactivation");
    reenabled.enabled = true;
    GitSyncLifecycleStore::update_profile(&store, reenabled, None)
      .await
      .expect("reenable original consumer without resetting shared rotation");
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(target_workspace)
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("revoke former steward's Workspace access");
    let later = Utc::now() + chrono::Duration::days(100);
    let next = admit_shared_rotation(&pool, &store, source.credential_id.expect("shared replacement"), later).await;
    assert_eq!(next.profile_id, source_id);
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(source_workspace)
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("revoke steward after admission, before provider request");
    assert!(
      GitTokenRotationStore::admitted(&store, source_id, next.attempt_id)
        .await
        .is_err(),
      "a queued attempt must not load the secret after steward access is revoked"
    );
    GitTokenRotationStore::record_pre_request_failure(&store, source_id, next.attempt_id, "not sent", later)
      .await
      .expect("preserve failed attempt state on new steward");
    assert_eq!(
      GitTokenRotationStore::status(&store, source_id)
        .await
        .expect("shared status")
        .expect("one rotation row")
        .state,
      GitTokenRotationState::Failed
    );
    assert!(
      GitTokenRotationStore::completion_by_attempt(&store, target_id, admission.attempt_id)
        .await
        .expect("obsolete attempt lookup")
        .is_none()
    );

    let admin = SqlxAdminStore::new(pool.clone());
    admin
      .delete_workspace(source_workspace)
      .await
      .expect("delete the current steward after a failed attempt");
    assert_eq!(
      GitTokenRotationStore::status(&store, target_id)
        .await
        .expect("read remaining configuration")
        .expect("one rotation row after deletion")
        .state,
      GitTokenRotationState::Failed
    );
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now()) ON CONFLICT (workspace_id, user_id) DO NOTHING",
    )
    .bind(target_workspace)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("restore last consumer's access");
    let next_day = later + chrono::Duration::days(1);
    let surviving = admit_shared_rotation(
      &pool,
      &store,
      source.credential_id.expect("surviving credential"),
      next_day,
    )
    .await;
    assert_eq!(surviving.profile_id, target_id);
    GitTokenRotationStore::record_pre_request_failure(&store, target_id, surviving.attempt_id, "not sent", next_day)
      .await
      .expect("close final attempt without provider I/O");
    GitTokenRotationStore::configure(&store, target_id, rotation_configuration(true))
      .await
      .expect("explicit reconfiguration resets the pre-request Failed state");
    let reconfigured = admit_shared_rotation(
      &pool,
      &store,
      source.credential_id.expect("same expiry credential"),
      next_day,
    )
    .await;
    assert_ne!(
      reconfigured.attempt_id, surviving.attempt_id,
      "a newer definition can admit the same expiry slot without reusing a closed attempt"
    );
    GitTokenRotationStore::record_pre_request_failure(&store, target_id, reconfigured.attempt_id, "not sent", next_day)
      .await
      .expect("close reconfigured attempt without provider I/O");
    admin
      .delete_workspace(target_workspace)
      .await
      .expect("delete last consumer");
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE event_type='git_rotation_due' AND payload->>'profileId'=ANY($1)")
    .bind(vec![source_id.to_string(), target_id.to_string()])
    .execute(&pool)
    .await
    .expect("cleanup owned native rotation handoffs");
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Err(panic) = body {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn token_rotation_admission_is_single_row_and_mutually_exclusive_with_runs() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let credential_id = seed_expiring_token(&pool, profile_id).await;
  let store = SqlxGitSyncStore::new(pool.clone());

  let (without_rotation, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .expect("normal admission without a rotation row");
  assert!(inserted);
  sqlx::query("UPDATE git_sync_runs SET status = 'Cancelled', finished_at = now() WHERE id = $1")
    .bind(without_rotation.id)
    .execute(&pool)
    .await
    .expect("finish baseline run");

  GitTokenRotationStore::configure(&store, profile_id, rotation_configuration(false))
    .await
    .expect("configure disabled rotation");
  let (disabled_rotation, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .expect("normal admission with disabled rotation");
  assert!(inserted);
  sqlx::query("UPDATE git_sync_runs SET status = 'Cancelled', finished_at = now() WHERE id = $1")
    .bind(disabled_rotation.id)
    .execute(&pool)
    .await
    .expect("finish disabled-rotation run");

  GitTokenRotationStore::configure(&store, profile_id, rotation_configuration(true))
    .await
    .expect("enable the one rotation row");
  let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_token_rotation WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("rotation row count");
  assert_eq!(row_count, 1, "configuration must remain one row per profile");

  let (pending, inserted) = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .expect("normal admission remains available before rotation");
  assert!(inserted);
  assert!(matches!(
    GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true).await,
    Err(GitTokenRotationStoreError::UnfinishedRun)
  ));
  sqlx::query("UPDATE git_sync_runs SET status = 'Cancelled', finished_at = now() WHERE id = $1")
    .bind(pending.id)
    .execute(&pool)
    .await
    .expect("finish blocking run");

  // Extract metadata holds repository ownership without a normal run marker.
  // Its actual I/O must still exclude rotation and credential replacement.
  use myoxus_application::git_sync::{GitSyncRepositoryCoordination, GitSyncRepositoryScope};
  let profile = store.get_profile(profile_id).await.unwrap();
  let guard = myoxus_infrastructure::git_sync::PgGitSyncRepositoryCoordination::new(pool.clone())
    .acquire(&GitSyncRepositoryScope::new(&profile.repo_url, &profile.branch).unwrap())
    .await
    .unwrap();
  assert!(matches!(
    GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true).await,
    Err(GitTokenRotationStoreError::Conflict)
  ));
  assert!(
    GitSyncLifecycleStore::update_profile(
      &store,
      profile,
      Some(EncryptedGitCredential {
        label: "blocked metadata-time replacement".into(),
        ciphertext: vec![1, 2, 3],
        expires_at: None,
      })
    )
    .await
    .is_err()
  );
  guard.release().await.unwrap();

  let admission = GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true)
    .await
    .expect("admit rotation")
    .expect("due rotation");
  assert_eq!(admission.credential_id, credential_id);
  assert!(matches!(
    GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true).await,
    Err(GitTokenRotationStoreError::RotationInProgress)
  ));
  let run_error = store
    .create_pending_run_if_absent(profile_id, SyncDirection::Bidirectional, GitSyncRunSource::Manual)
    .await
    .expect_err("a normal run must defer while rotation is active");
  assert!(run_error.to_string().contains("token rotation is active"));

  GitTokenRotationStore::record_pre_request_failure(
    &store,
    profile_id,
    admission.attempt_id,
    "local request setup failed",
    Utc::now(),
  )
  .await
  .expect("record safe pre-request failure");
  assert!(
    GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true)
      .await
      .expect("same-day retry decision")
      .is_none(),
    "pre-request failures retry no more than once per UTC day"
  );

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn token_rotation_replacement_rollback_manual_recovery_and_cascade_preserve_lifecycle() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let original_credential_id = seed_expiring_token(&pool, profile_id).await;
  let store = SqlxGitSyncStore::new(pool.clone());
  GitTokenRotationStore::configure(&store, profile_id, rotation_configuration(true))
    .await
    .expect("configure rotation");
  let admission = GitTokenRotationStore::admit(&store, profile_id, Utc::now(), true)
    .await
    .expect("admit rotation")
    .expect("forced rotation");

  let rotating_profile = store.get_profile(profile_id).await.expect("profile during rotation");
  assert!(
    GitSyncLifecycleStore::update_profile(
      &store,
      rotating_profile,
      Some(EncryptedGitCredential {
        label: "forbidden concurrent replacement".into(),
        ciphertext: vec![4_u8, 5, 6],
        expires_at: Some(Utc::now() + chrono::Duration::days(90)),
      }),
    )
    .await
    .is_err(),
    "the normal lifecycle must not replace a credential while rotation owns the profile"
  );

  let mut stale_admission = admission.clone();
  stale_admission.attempt_id = Uuid::new_v4();
  assert!(matches!(
    GitTokenRotationStore::install_replacement(
      &store,
      &stale_admission,
      &EncryptedGitCredential {
        label: "replacement".into(),
        ciphertext: vec![9_u8, 9, 9],
        expires_at: Some(Utc::now() + chrono::Duration::days(90)),
      },
      Utc::now(),
    )
    .await,
    Err(GitTokenRotationStoreError::Conflict)
  ));
  let active_after_rollback: Option<Uuid> =
    sqlx::query_scalar("SELECT credential_id FROM git_sync_profiles WHERE id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("active credential after rollback");
  assert_eq!(active_after_rollback, Some(original_credential_id));
  let credential_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_credentials WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("credential count after rollback");
  assert_eq!(credential_count, 1, "a rejected swap must not leak a credential row");

  GitTokenRotationStore::record_manual_intervention(
    &store,
    profile_id,
    admission.attempt_id,
    "provider outcome requires operator replacement",
    Utc::now(),
  )
  .await
  .expect("record manual intervention");
  let profile = store
    .get_profile(profile_id)
    .await
    .expect("profile for manual recovery");
  GitSyncLifecycleStore::update_profile(
    &store,
    profile,
    Some(EncryptedGitCredential {
      label: "operator replacement".into(),
      ciphertext: vec![7_u8, 8, 9],
      expires_at: Some(Utc::now() + chrono::Duration::days(90)),
    }),
  )
  .await
  .expect("existing lifecycle credential replacement");
  let recovered = GitTokenRotationStore::status(&store, profile_id)
    .await
    .expect("rotation status")
    .expect("rotation row");
  assert_eq!(recovered.state, GitTokenRotationState::Configured);
  assert!(recovered.diagnosis.is_none());
  let credential_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_credentials WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("credential count after recovery");
  assert_eq!(credential_count, 1, "manual recovery keeps one active credential");

  let mut incompatible = store.get_profile(profile_id).await.expect("profile for auth change");
  incompatible.repo_url = "ssh://git@example.com/repo.git".into();
  GitSyncLifecycleStore::update_profile(&store, incompatible, None)
    .await
    .expect("incompatible normal profile update");
  assert!(
    !GitTokenRotationStore::status(&store, profile_id)
      .await
      .expect("disabled rotation status")
      .expect("rotation row")
      .enabled,
    "an incompatible repository transport disables rotation only"
  );

  GitSyncLifecycleStore::delete_profile(&store, profile_id)
    .await
    .expect("delete profile through normal lifecycle");
  let rotation_exists: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_token_rotation WHERE profile_id = $1)")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("rotation cascade check");
  assert!(!rotation_exists, "profile deletion must cascade the rotation row");

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn reconciliation_apply_is_atomic_audited_and_idempotent() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let binding_id = seed_binding(&pool, profile_id, workspace_id).await;
  sqlx::query("UPDATE git_sync_profiles SET enabled = false, updated_at = now() WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .expect("disable profile for reconciliation");
  let store = SqlxGitSyncStore::new(pool.clone());
  let profile = store.get_profile(profile_id).await.expect("profile");
  let mut binding = store.get_binding(binding_id).await.expect("binding");
  let remote_oid = "a".repeat(40);
  binding.repo_path = "content/reconciled.md".to_string();
  binding.last_commit_oid = Some(remote_oid.clone());
  binding.content_hash = Some("b".repeat(64));
  let baseline = GitSyncBaseline {
    binding_id,
    content_hash: "b".repeat(64),
    commit_oid: remote_oid.clone(),
    myoxus_updated_at: binding.updated_at,
    captured_at: Utc::now(),
  };
  let report = GitSyncReconciliationReport {
    profile_id,
    workspace_id,
    remote_oid: remote_oid.clone(),
    manifest_schema_version: 1,
    manifest_documents: 1,
    inventory: GitSyncReconciliationCounts {
      documents: 1,
      bindings: 1,
      baselines: 0,
      file_bindings: 0,
      file_baselines: 0,
      runs: 0,
      version_links: 0,
    },
    binding_updates: 1,
    baseline_upserts: 1,
    baseline_deletes: 0,
    file_baseline_commit_clears: 0,
    version_link_commit_clears: 0,
    completed_reconciliation_runs: 0,
    binding_adoptions: Vec::new(),
    unresolved_remote_documents: Vec::new(),
    changes_required: true,
  };
  let plan = GitSyncReconciliationPlan {
    profile_id,
    profile_updated_at: profile.updated_at,
    expected_remote_oid: remote_oid.clone(),
    binding_adoptions: Vec::new(),
    unresolved_remote_documents: Vec::new(),
    binding_updates: vec![binding],
    baseline_upserts: vec![baseline],
    baseline_deletes: Vec::new(),
    file_baseline_updates: Vec::new(),
    version_link_clear_commits: Vec::new(),
    completed_reconciliation_runs: Vec::new(),
    report,
  };

  store.apply(plan.clone()).await.expect("first reconciliation apply");
  store
    .apply(plan)
    .await
    .expect("repeated reconciliation apply must be idempotent");

  let persisted = store.get_binding(binding_id).await.expect("reconciled binding");
  assert_eq!(persisted.repo_path, "content/reconciled.md");
  assert_eq!(persisted.last_commit_oid.as_deref(), Some(remote_oid.as_str()));
  let persisted_baseline = store
    .get_baseline(binding_id)
    .await
    .expect("baseline query")
    .expect("reconstructed baseline");
  assert_eq!(persisted_baseline.commit_oid, remote_oid);
  let audit_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM admin_audit_log
     WHERE event_key = 'git_sync.reconcile.apply' AND target_id = $1",
  )
  .bind(profile_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("audit count");
  assert_eq!(
    audit_count, 1,
    "an unchanged repeated apply must not emit another audit event"
  );

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn reconciliation_adoption_is_trigger_owned_atomic_and_idempotent() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  sqlx::query("UPDATE git_sync_profiles SET enabled = false, updated_at = now() WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .expect("disable profile for reconciliation");
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Adopted document')")
    .bind(doc_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("create adoptable document");
  let store = SqlxGitSyncStore::new(pool.clone());
  let profile = store.get_profile(profile_id).await.expect("profile");
  let remote_oid = "c".repeat(40);
  let sync_id = Uuid::new_v4();
  let binding_id = Uuid::new_v4();
  let repo_path = "content/adopted.md".to_string();
  let binding = GitSyncBinding {
    id: binding_id,
    profile_id,
    workspace_id,
    doc_id,
    sync_id,
    repo_path: repo_path.clone(),
    last_commit_oid: Some(remote_oid.clone()),
    content_hash: Some("d".repeat(64)),
    structure_hash: Some("e".repeat(64)),
    tombstone: false,
    created_at: Utc::now(),
    updated_at: Utc::now(),
  };
  let baseline = GitSyncBaseline {
    binding_id,
    content_hash: "d".repeat(64),
    commit_oid: remote_oid.clone(),
    myoxus_updated_at: Utc::now(),
    captured_at: Utc::now(),
  };
  let adoption = GitSyncBindingAdoption {
    binding: binding.clone(),
    baseline,
  };
  let identity = GitSyncReconciliationDocumentIdentity {
    doc_id,
    sync_id,
    repo_path: repo_path.clone(),
  };
  let report = GitSyncReconciliationReport {
    profile_id,
    workspace_id,
    remote_oid: remote_oid.clone(),
    manifest_schema_version: 1,
    manifest_documents: 1,
    inventory: GitSyncReconciliationCounts {
      documents: 1,
      bindings: 0,
      baselines: 0,
      file_bindings: 0,
      file_baselines: 0,
      runs: 0,
      version_links: 0,
    },
    binding_updates: 0,
    baseline_upserts: 0,
    baseline_deletes: 0,
    file_baseline_commit_clears: 0,
    version_link_commit_clears: 0,
    completed_reconciliation_runs: 0,
    binding_adoptions: vec![identity],
    unresolved_remote_documents: Vec::new(),
    changes_required: true,
  };
  let plan = GitSyncReconciliationPlan {
    profile_id,
    profile_updated_at: profile.updated_at,
    expected_remote_oid: remote_oid.clone(),
    binding_adoptions: vec![adoption],
    unresolved_remote_documents: Vec::new(),
    binding_updates: Vec::new(),
    baseline_upserts: Vec::new(),
    baseline_deletes: Vec::new(),
    file_baseline_updates: Vec::new(),
    version_link_clear_commits: Vec::new(),
    completed_reconciliation_runs: Vec::new(),
    report,
  };

  store.apply(plan.clone()).await.expect("first binding adoption");
  store.apply(plan).await.expect("idempotent adoption replay");

  let counts: (i64, i64, i64) = sqlx::query_as(
    r#"
    SELECT
      (SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_baselines WHERE binding_id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_path_owners
       WHERE profile_id = $2 AND repo_path = $3 AND owner_kind = 'document'
         AND owner_id = $4)
    "#,
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(&repo_path)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("adoption rows");
  assert_eq!(counts, (1, 1, 1), "binding trigger must create exactly one owner");
  let audit_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM admin_audit_log
     WHERE event_key = 'git_sync.reconcile.apply' AND target_id = $1",
  )
  .bind(profile_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("adoption audit count");
  assert_eq!(audit_count, 1, "unchanged adoption replay must not emit a second audit");

  let collision_path = "content/collision.bin";
  sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash,
        mime_type, file_size, tombstoned)
     VALUES ($1, $2, $3, 'collision-blob', $4, $5,
             'application/octet-stream', 1, false)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(workspace_id)
  .bind(collision_path)
  .bind("f".repeat(64))
  .execute(&pool)
  .await
  .expect("create file path owner");
  let collision_doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Collision document')")
    .bind(collision_doc_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("create collision document");
  let collision_binding_id = Uuid::new_v4();
  let collision_sync_id = Uuid::new_v4();
  let mut collision_binding = binding;
  collision_binding.id = collision_binding_id;
  collision_binding.doc_id = collision_doc_id;
  collision_binding.sync_id = collision_sync_id;
  collision_binding.repo_path = collision_path.to_string();
  let collision_baseline = GitSyncBaseline {
    binding_id: collision_binding_id,
    content_hash: "d".repeat(64),
    commit_oid: remote_oid.clone(),
    myoxus_updated_at: Utc::now(),
    captured_at: Utc::now(),
  };
  let collision_report = GitSyncReconciliationReport {
    profile_id,
    workspace_id,
    remote_oid: remote_oid.clone(),
    manifest_schema_version: 1,
    manifest_documents: 1,
    inventory: GitSyncReconciliationCounts {
      documents: 2,
      bindings: 1,
      baselines: 1,
      file_bindings: 1,
      file_baselines: 0,
      runs: 0,
      version_links: 0,
    },
    binding_updates: 0,
    baseline_upserts: 0,
    baseline_deletes: 0,
    file_baseline_commit_clears: 0,
    version_link_commit_clears: 0,
    completed_reconciliation_runs: 0,
    binding_adoptions: vec![GitSyncReconciliationDocumentIdentity {
      doc_id: collision_doc_id,
      sync_id: collision_sync_id,
      repo_path: collision_path.to_string(),
    }],
    unresolved_remote_documents: Vec::new(),
    changes_required: true,
  };
  let collision_plan = GitSyncReconciliationPlan {
    profile_id,
    profile_updated_at: profile.updated_at,
    expected_remote_oid: remote_oid,
    binding_adoptions: vec![GitSyncBindingAdoption {
      binding: collision_binding,
      baseline: collision_baseline,
    }],
    unresolved_remote_documents: Vec::new(),
    binding_updates: Vec::new(),
    baseline_upserts: Vec::new(),
    baseline_deletes: Vec::new(),
    file_baseline_updates: Vec::new(),
    version_link_clear_commits: Vec::new(),
    completed_reconciliation_runs: Vec::new(),
    report: collision_report,
  };
  store
    .apply(collision_plan)
    .await
    .expect_err("cross-kind owner must reject the whole adoption");
  let collision_rows: (i64, i64, i64) = sqlx::query_as(
    r#"
    SELECT
      (SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_baselines WHERE binding_id = $1),
      (SELECT COUNT(*)::bigint FROM git_sync_path_owners
       WHERE profile_id = $2 AND repo_path = $3 AND owner_kind = 'file')
    "#,
  )
  .bind(collision_binding_id)
  .bind(profile_id)
  .bind(collision_path)
  .fetch_one(&pool)
  .await
  .expect("collision rollback rows");
  assert_eq!(
    collision_rows,
    (0, 0, 1),
    "failed adoption must preserve the file owner and roll back binding/baseline"
  );

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn post_push_constraint_failure_rolls_back_normal_state_and_records_reconciliation() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let store = SqlxGitSyncStore::new(pool.clone());
  sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash,
        mime_type, file_size, tombstoned)
     VALUES ($1, $2, $3, 'existing-file', 'content/transactional-import.md',
             $4, 'application/octet-stream', 1, false)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(workspace_id)
  .bind("b".repeat(64))
  .execute(&pool)
  .await
  .expect("cross-kind path owner");
  let run_id = Uuid::new_v4();
  let job_id = format!("git-sync-{run_id}");
  sqlx::query(
    "INSERT INTO git_sync_runs
       (id, profile_id, direction, trigger_source, status, started_at, job_id)
     VALUES ($1, $2, 'Bidirectional', 'Manual', 'Running', now(), $3)",
  )
  .bind(run_id)
  .bind(profile_id)
  .bind(&job_id)
  .execute(&pool)
  .await
  .expect("running sync run");
  let promotion_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_blob_promotions
       (id, run_id, profile_id, workspace_id, stage_key, final_key,
        newly_promoted)
     VALUES ($1, $2, $3, $4, $5, $6, true)",
  )
  .bind(promotion_id)
  .bind(run_id)
  .bind(profile_id)
  .bind(workspace_id)
  .bind(format!("git-sync-staging/{profile_id}/{promotion_id}"))
  .bind(format!("git-sync/{profile_id}/{}", "b".repeat(64)))
  .execute(&pool)
  .await
  .expect("prepared blob promotion");
  let mut run = store.get_run(run_id).await.expect("load run");
  run.docs_created = 3;
  run.docs_updated = 2;
  run.docs_deleted = 1;
  run.conflicts_found = 4;
  run.observed_remote_oid = Some("a".repeat(40));
  run.complete(Some("a".repeat(40))).expect("complete plan state");

  let doc_id = Uuid::new_v4();
  let plan = GitSyncPostPushPlan {
    run,
    workspace_id,
    expected_job_id: job_id.clone(),
    document_upserts: vec![PreparedDocumentUpsert {
      observed_at: Utc::now(),
      doc_id,
      workspace_id,
      expected_create: true,
      title: "Transactional import".to_string(),
      actor_user_id: admin_id,
      payload: vec![0, 0],
      provenance: InitialDocumentProvenance {
        idempotency_key: Some(format!("git-sync-test-{run_id}")),
        client_family: Some("git-sync-test".to_string()),
        client_version: None,
        client_instance_id: Some(profile_id.to_string()),
        provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
        client_created_at: None,
        client_updated_at: None,
        client_created_by: None,
        client_updated_by: None,
        historical_user_mapping_id: None,
        source_property_doc_revision: Some("content/transactional-import.md".to_string()),
      },
    }],
    document_deletes: vec![],
    document_bindings: vec![GitSyncBinding {
      id: Uuid::new_v4(),
      profile_id,
      workspace_id,
      doc_id,
      sync_id: Uuid::new_v4(),
      repo_path: "content/transactional-import.md".to_string(),
      last_commit_oid: Some("a".repeat(40)),
      content_hash: Some("b".repeat(64)),
      structure_hash: Some("c".repeat(64)),
      tombstone: false,
      created_at: Utc::now(),
      updated_at: Utc::now(),
    }],
    document_tombstone_ids: vec![],
    document_baselines: vec![],
    document_conflicts: vec![],
    file_bindings: vec![],
    file_tombstone_paths: vec![],
    file_baselines: vec![],
    file_baseline_deletes: vec![],
    file_conflicts: vec![],
    version_links: vec![],
    blob_promotion_ids: vec![promotion_id],
    partial: None,
  };
  store
    .commit_post_push(&plan)
    .await
    .expect_err("binding FK failure must abort finalization");
  let document_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("document rollback check");
  assert!(
    !document_exists,
    "document upsert before the failing binding must roll back"
  );
  let persisted_run = store.get_run(run_id).await.expect("run after rollback");
  assert_eq!(persisted_run.status, RunStatus::Running);
  assert!(persisted_run.commit_after.is_none());
  let promotion_committed: bool = sqlx::query_scalar("SELECT db_committed FROM git_sync_blob_promotions WHERE id = $1")
    .bind(promotion_id)
    .fetch_one(&pool)
    .await
    .expect("promotion rollback check");
  assert!(
    !promotion_committed,
    "the blob ledger must roll back with every other normal-state write"
  );

  assert!(
    store
      .mark_reconciliation_required(
        &plan.run,
        &job_id,
        &"a".repeat(40),
        "injected post-push constraint failure",
      )
      .await
      .expect("record reconciliation")
  );
  let reconciled = store.get_run(run_id).await.expect("reconciled run");
  assert_eq!(reconciled.status, RunStatus::Failed);
  assert!(reconciled.reconciliation_required);
  assert_eq!(
    reconciled.observed_remote_oid.as_deref(),
    Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  );
  assert!(reconciled.commit_after.is_none());
  assert_eq!(
    (
      reconciled.docs_created,
      reconciled.docs_updated,
      reconciled.docs_deleted,
      reconciled.conflicts_found,
    ),
    (3, 2, 1, 4),
    "reconciliation must retain the exact counters prepared before push"
  );
  let retained_promotion: (bool, bool) = sqlx::query_as(
    "SELECT EXISTS(SELECT 1 FROM git_sync_blob_promotions WHERE id = $1),
            COALESCE((SELECT db_committed FROM git_sync_blob_promotions WHERE id = $1), false)",
  )
  .bind(promotion_id)
  .fetch_one(&pool)
  .await
  .expect("retained promotion ledger");
  assert_eq!(
    retained_promotion,
    (true, false),
    "rolled-back normal persistence must retain its uncommitted promotion evidence"
  );

  cleanup(&pool, workspace_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn post_push_import_cannot_overwrite_a_document_snapshot_from_another_workspace() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (workspace_id, profile_id) = seed_profile(&pool, admin_id).await;
  let foreign_workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let foreign_doc_id = Uuid::new_v4();
  let original_payload = vec![7, 7, 7];
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Foreign')")
    .bind(foreign_doc_id)
    .bind(foreign_workspace_id)
    .execute(&pool)
    .await
    .expect("foreign document");
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(foreign_doc_id)
  .bind(foreign_workspace_id)
  .bind(&original_payload)
  .execute(&pool)
  .await
  .expect("foreign snapshot");

  let run_id = Uuid::new_v4();
  let job_id = format!("git-sync-{run_id}");
  sqlx::query(
    "INSERT INTO git_sync_runs
       (id, profile_id, direction, trigger_source, status, started_at, job_id)
     VALUES ($1, $2, 'GitToMyoxus', 'Manual', 'Running', now(), $3)",
  )
  .bind(run_id)
  .bind(profile_id)
  .bind(&job_id)
  .execute(&pool)
  .await
  .expect("running sync run");
  let store = SqlxGitSyncStore::new(pool.clone());
  let mut run = store.get_run(run_id).await.expect("load run");
  let remote_oid = "d".repeat(40);
  run.observed_remote_oid = Some(remote_oid.clone());
  run.complete(Some(remote_oid)).expect("complete planned run");
  let plan = GitSyncPostPushPlan {
    run,
    workspace_id,
    expected_job_id: job_id,
    document_upserts: vec![PreparedDocumentUpsert {
      observed_at: Utc::now(),
      doc_id: foreign_doc_id,
      workspace_id,
      expected_create: true,
      title: "Cross-workspace overwrite".to_string(),
      actor_user_id: admin_id,
      payload: vec![9, 9, 9],
      provenance: InitialDocumentProvenance {
        idempotency_key: Some(format!("cross-workspace-{run_id}")),
        client_family: Some("git-sync-test".to_string()),
        client_version: None,
        client_instance_id: Some(profile_id.to_string()),
        provenance_mode: InitialDocumentProvenanceMode::ExplicitImport,
        client_created_at: None,
        client_updated_at: None,
        client_created_by: None,
        client_updated_by: None,
        historical_user_mapping_id: None,
        source_property_doc_revision: Some("content/foreign.md".to_string()),
      },
    }],
    document_deletes: vec![],
    document_bindings: vec![],
    document_tombstone_ids: vec![],
    document_baselines: vec![],
    document_conflicts: vec![],
    file_bindings: vec![],
    file_tombstone_paths: vec![],
    file_baselines: vec![],
    file_baseline_deletes: vec![],
    file_conflicts: vec![],
    version_links: vec![],
    blob_promotion_ids: vec![],
    partial: None,
  };
  let error = store
    .commit_post_push(&plan)
    .await
    .expect_err("cross-workspace document identity must abort the transaction");
  assert!(
    error.to_string().contains("another workspace"),
    "ownership failure must be diagnosable: {error}"
  );
  let persisted_payload: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id = $1")
    .bind(foreign_doc_id)
    .fetch_one(&pool)
    .await
    .expect("foreign snapshot after rejected import");
  assert_eq!(persisted_payload, original_payload);
  assert_eq!(
    store.get_run(run_id).await.expect("run after rejection").status,
    RunStatus::Running
  );

  cleanup(&pool, workspace_id, admin_id).await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(foreign_workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup foreign workspace");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Unique constraint: max 1 enabled profile per workspace ──────────────

#[tokio::test]
async fn unique_enabled_profile_per_workspace() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, _profile_id) = seed_profile(&pool, admin_id).await;

  // Try to insert a second enabled profile for the same workspace
  let result = sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, 'https://example.com/repo2.git', 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(Uuid::new_v4())
  .bind(ws_id)
  .bind(admin_id)
  .execute(&pool)
  .await;

  assert!(
    result.is_err(),
    "second enabled profile for same workspace must be rejected by unique constraint"
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── FK cascade: deleting profile cascades bindings and conflicts ────────

#[tokio::test]
async fn profile_delete_cascades_bindings_and_conflicts() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let (target_ws_id, target_profile_id) = seed_profile(&pool, admin_id).await;
  let isolated_remote = format!("https://example.com/profile-cascade-{ws_id}.git");
  sqlx::query("UPDATE git_sync_profiles SET repo_url = $2 WHERE id = ANY($1)")
    .bind(vec![profile_id, target_profile_id])
    .bind(isolated_remote)
    .execute(&pool)
    .await
    .expect("isolate this cascade test's shared remote scope");
  sqlx::query("UPDATE git_sync_profiles SET enabled = false WHERE id = $1")
    .bind(target_profile_id)
    .execute(&pool)
    .await
    .expect("disable competing profile without releasing its namespace");
  let store = SqlxGitSyncStore::new(pool.clone());
  let source = store.get_profile(profile_id).await.expect("read source profile");
  let target = store
    .get_profile(target_profile_id)
    .await
    .expect("read overlapping profile");
  assert!(store.assert_profile_scope_unambiguous(&source).await.is_err());
  assert!(store.assert_profile_scope_unambiguous(&target).await.is_err());
  let fence = store
    .add_scope_exclusion(
      profile_id,
      "content/projects/manual",
      true,
      Some(target_profile_id),
      Uuid::new_v4(),
      0,
    )
    .await
    .expect("publish source-owned scope fence");
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(target_profile_id)
    .execute(&pool)
    .await
    .expect("remove destination profile without releasing source fence");
  assert!(
    store.create_profile(&target).await.is_err(),
    "profile creation must reject a root and manifest already configured on this remote branch"
  );
  let retained = store
    .scope_exclusions(profile_id)
    .await
    .expect("read surviving source fence");
  assert_eq!(retained.len(), 1);
  assert_eq!(retained[0].id, fence.id);
  assert!(retained[0].destination_profile_id.is_none());
  let current_source = store.get_profile(profile_id).await.expect("read current fenced source");
  store
    .assert_profile_scope_unambiguous(&current_source)
    .await
    .expect("detached fence keeps paths excluded without stopping source sync");
  let mut replacement = target.clone();
  replacement.root_path = "content/projects/manual".into();
  replacement.manifest_path = myoxus_application::git_sync::export::extracted_manifest_path(&replacement.root_path)
    .expect("derive a nested manifest");
  assert!(
    store.create_profile(&replacement).await.is_err(),
    "a detached fence must not admit an unrelated replacement profile at the old destination"
  );
  sqlx::query(
    "INSERT INTO git_sync_profiles (id, workspace_id, owner_id, repo_url, branch, root_path, manifest_path,
       sync_direction, trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, $4, 'main', $5, $6, 'Bidirectional', 'Manual', 'HttpsToken', false)",
  )
  .bind(replacement.id)
  .bind(target_ws_id)
  .bind(admin_id)
  .bind(&replacement.repo_url)
  .bind(&replacement.root_path)
  .bind(&replacement.manifest_path)
  .execute(&pool)
  .await
  .expect("simulate an already configured claimant at the detached root");
  let replacement = store.get_profile(replacement.id).await.expect("read claimant");
  assert!(store.assert_profile_scope_unambiguous(&replacement).await.is_err());
  assert!(store.assert_profile_scope_unambiguous(&current_source).await.is_err());
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(replacement.id)
    .execute(&pool)
    .await
    .expect("remove unauthorized claimant");
  let binding_id = seed_binding(&pool, profile_id, ws_id).await;
  sqlx::query("UPDATE docs SET workspace_id = $2 WHERE id = (SELECT doc_id FROM git_sync_bindings WHERE id = $1)")
    .bind(binding_id)
    .bind(target_ws_id)
    .execute(&pool)
    .await
    .expect("simulate a document moving without a binding handoff");
  assert!(
    store
      .assert_bound_documents_in_workspace(&current_source)
      .await
      .is_err(),
    "the missing source document must not be planned as a Git deletion"
  );
  sqlx::query("UPDATE docs SET workspace_id = $2 WHERE id = (SELECT doc_id FROM git_sync_bindings WHERE id = $1)")
    .bind(binding_id)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("restore the owning Workspace for cascade cleanup");
  store
    .assert_bound_documents_in_workspace(&current_source)
    .await
    .expect("legitimate in-scope bindings remain runnable");

  // Create a conflict for the binding
  let conflict_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_conflicts (id, profile_id, binding_id, doc_id, repo_path, conflict_type, resolution)
     VALUES ($1, $2, $3, (SELECT doc_id FROM git_sync_bindings WHERE id = $3), 'content/test.md', 'BothModified', 'Open')",
  )
  .bind(conflict_id)
  .bind(profile_id)
  .bind(binding_id)
  .execute(&pool)
  .await
  .expect("create conflict");

  // Verify data exists
  let binding_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("binding count query must succeed");
  assert_eq!(binding_count, 1);

  let conflict_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_conflicts WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .expect("conflict count query must succeed");
  assert_eq!(conflict_count, 1);

  // Delete profile — should cascade
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .expect("delete profile");

  // Verify cascade
  let binding_after: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("binding cascade count query must succeed");
  assert_eq!(binding_after, 0, "binding must be cascaded when profile is deleted");

  let conflict_after: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_conflicts WHERE id = $1")
    .bind(conflict_id)
    .fetch_one(&pool)
    .await
    .expect("conflict cascade count query must succeed");
  assert_eq!(conflict_after, 0, "conflict must be cascaded when profile is deleted");
  assert!(
    store
      .scope_exclusions(profile_id)
      .await
      .expect("read deleted source fences")
      .is_empty()
  );

  cleanup(&pool, target_ws_id, admin_id).await;
  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Unique sync_id per profile (non-tombstoned) ────────────────────────

#[tokio::test]
async fn duplicate_sync_id_rejected_for_active_bindings() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;

  let sync_id = Uuid::new_v4();
  let doc1 = Uuid::new_v4();
  let doc2 = Uuid::new_v4();

  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Doc1')")
    .bind(doc1)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("doc1 insert must succeed");
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Doc2')")
    .bind(doc2)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("doc2 insert must succeed");

  // First binding with sync_id
  sqlx::query(
    "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path, tombstone)
     VALUES ($1, $2, $3, $4, $5, 'a.md', false)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(ws_id)
  .bind(doc1)
  .bind(sync_id)
  .execute(&pool)
  .await
  .expect("first binding");

  // Second binding with SAME sync_id and tombstone=false → should fail
  let result = sqlx::query(
    "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path, tombstone)
     VALUES ($1, $2, $3, $4, $5, 'b.md', false)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(ws_id)
  .bind(doc2)
  .bind(sync_id)
  .execute(&pool)
  .await;

  assert!(
    result.is_err(),
    "duplicate sync_id for same profile with tombstone=false must be rejected"
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Tombstoned binding allows reuse of sync_id ─────────────────────────

#[tokio::test]
async fn tombstoned_sync_id_allows_reuse() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;

  let sync_id = Uuid::new_v4();
  let doc1 = Uuid::new_v4();
  let doc2 = Uuid::new_v4();

  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Doc1')")
    .bind(doc1)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("doc1 insert must succeed");
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Doc2')")
    .bind(doc2)
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("doc2 insert must succeed");

  // First binding — tombstoned
  sqlx::query(
    "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path, tombstone)
     VALUES ($1, $2, $3, $4, $5, 'a.md', true)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(ws_id)
  .bind(doc1)
  .bind(sync_id)
  .execute(&pool)
  .await
  .expect("tombstoned binding");

  // Second binding with same sync_id but tombstone=false → should succeed
  // because the unique index is partial: WHERE tombstone = false
  let result = sqlx::query(
    "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path, tombstone)
     VALUES ($1, $2, $3, $4, $5, 'b.md', false)",
  )
  .bind(Uuid::new_v4())
  .bind(profile_id)
  .bind(ws_id)
  .bind(doc2)
  .bind(sync_id)
  .execute(&pool)
  .await;

  assert!(
    result.is_ok(),
    "reusing sync_id when previous binding is tombstoned must succeed"
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Tombstone: setting tombstone=true preserves the row ─────────────────

#[tokio::test]
async fn tombstone_binding_preserves_row() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let binding_id = seed_binding(&pool, profile_id, ws_id).await;

  // Tombstone the binding
  sqlx::query("UPDATE git_sync_bindings SET tombstone = true WHERE id = $1")
    .bind(binding_id)
    .execute(&pool)
    .await
    .expect("tombstone binding");

  // Row must still exist
  let row = sqlx::query("SELECT tombstone FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("tombstoned row must still exist");
  assert!(row.get::<bool, _>("tombstone"), "tombstone must be true");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Hard-delete binding removes row ─────────────────────────────────────

#[tokio::test]
async fn hard_delete_binding_removes_row() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let binding_id = seed_binding(&pool, profile_id, ws_id).await;

  sqlx::query("DELETE FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .execute(&pool)
    .await
    .expect("hard delete binding");

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("hard-delete count query must succeed");
  assert_eq!(count, 0, "hard-deleted binding must be gone");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Binding deletion cascades conflicts ─────────────────────────────────

#[tokio::test]
async fn binding_delete_cascades_conflicts() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let binding_id = seed_binding(&pool, profile_id, ws_id).await;

  let conflict_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_conflicts (id, profile_id, binding_id, doc_id, repo_path, conflict_type, resolution)
     VALUES ($1, $2, $3, (SELECT doc_id FROM git_sync_bindings WHERE id = $3), 'content/test.md', 'BothModified', 'Open')",
  )
  .bind(conflict_id)
  .bind(profile_id)
  .bind(binding_id)
  .execute(&pool)
  .await
  .expect("create conflict");

  // Delete the binding
  sqlx::query("DELETE FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .execute(&pool)
    .await
    .expect("delete binding");

  // Conflict must be cascaded
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_conflicts WHERE id = $1")
    .bind(conflict_id)
    .fetch_one(&pool)
    .await
    .expect("conflict cascade count query must succeed");
  assert_eq!(count, 0, "conflict must be cascaded when binding is deleted");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Restore: un-tombstone a binding ─────────────────────────────────────

#[tokio::test]
async fn restore_tombstoned_binding() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let binding_id = seed_binding(&pool, profile_id, ws_id).await;

  // Tombstone
  sqlx::query("UPDATE git_sync_bindings SET tombstone = true WHERE id = $1")
    .bind(binding_id)
    .execute(&pool)
    .await
    .expect("tombstone update must succeed");

  // Restore
  sqlx::query("UPDATE git_sync_bindings SET tombstone = false WHERE id = $1")
    .bind(binding_id)
    .execute(&pool)
    .await
    .expect("restore binding");

  let row = sqlx::query("SELECT tombstone FROM git_sync_bindings WHERE id = $1")
    .bind(binding_id)
    .fetch_one(&pool)
    .await
    .expect("restored row");
  assert!(
    !row.get::<bool, _>("tombstone"),
    "restored binding must have tombstone=false"
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ─── Concurrency: parallel binding creation with same sync_id ──────────

/// INV: When two tasks try to create bindings with the same sync_id
/// concurrently, exactly one succeeds and the other fails with a unique
/// constraint violation. No duplicate bindings should ever exist.
#[tokio::test]
async fn concurrent_binding_creation_same_sync_id() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;

  let sync_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let doc_id2 = Uuid::new_v4();

  // Spawn two concurrent inserts with the same sync_id (UUID)
  let pool1 = pool.clone();
  let pool2 = pool.clone();

  let (r1, r2) = tokio::join!(
    async move {
      sqlx::query(
        "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path)
         VALUES ($1, $2, $3, $4, $5, 'path/a.md')",
      )
      .bind(Uuid::new_v4())
      .bind(profile_id)
      .bind(ws_id)
      .bind(doc_id)
      .bind(sync_id)
      .execute(&pool1)
      .await
    },
    async move {
      sqlx::query(
        "INSERT INTO git_sync_bindings (id, profile_id, workspace_id, doc_id, sync_id, repo_path)
         VALUES ($1, $2, $3, $4, $5, 'path/b.md')",
      )
      .bind(Uuid::new_v4())
      .bind(profile_id)
      .bind(ws_id)
      .bind(doc_id2)
      .bind(sync_id)
      .execute(&pool2)
      .await
    },
  );

  // Exactly one must succeed, one must fail
  let successes = [&r1, &r2].iter().filter(|r| r.is_ok()).count();
  assert_eq!(
    successes, 1,
    "exactly one concurrent insert must succeed, results: r1={r1:?}, r2={r2:?}"
  );

  // Verify only one binding exists
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_bindings WHERE profile_id = $1 AND sync_id = $2")
    .bind(profile_id)
    .bind(sync_id)
    .fetch_one(&pool)
    .await
    .expect("count query");
  assert_eq!(count, 1, "exactly one binding must exist for this sync_id");

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn active_repo_path_is_unique_across_document_and_file_bindings() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let (ws_id, profile_id) = seed_profile(&pool, admin_id).await;
  let document_binding_id = seed_binding(&pool, profile_id, ws_id).await;

  let file_binding_id = Uuid::new_v4();
  let conflicting_file = sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, 'fixture-blob', 'content/test.md', 'hash', 'text/plain', 4)",
  )
  .bind(file_binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .execute(&pool)
  .await;
  assert!(
    conflicting_file.is_err(),
    "a file binding must not claim an active document path"
  );

  sqlx::query("UPDATE git_sync_bindings SET tombstone = true WHERE id = $1")
    .bind(document_binding_id)
    .execute(&pool)
    .await
    .expect("tombstone document binding");
  sqlx::query(
    "INSERT INTO git_sync_file_bindings
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size)
     VALUES ($1, $2, $3, 'fixture-blob', 'content/test.md', 'hash', 'text/plain', 4)",
  )
  .bind(file_binding_id)
  .bind(profile_id)
  .bind(ws_id)
  .execute(&pool)
  .await
  .expect("released path can be claimed by file");

  let revive_document = sqlx::query("UPDATE git_sync_bindings SET tombstone = false WHERE id = $1")
    .bind(document_binding_id)
    .execute(&pool)
    .await;
  assert!(
    revive_document.is_err(),
    "a tombstoned document cannot be revived onto a file-owned path"
  );

  cleanup(&pool, ws_id, admin_id).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}
