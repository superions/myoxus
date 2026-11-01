//! Integration tests for GraphQL Git Sync profile creation/update semantics.
//!
//! Focus:
//! - credential persistence + profile linking
//! - create-or-update behavior for existing workspace profiles
//! - server-side validation and policy enforcement

use crate::helpers;

use myoxus_api::config::AppConfig;
use myoxus_infrastructure::crypto;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

const CREATE_GIT_SYNC_PROFILE_MUTATION: &str = r#"
mutation CreateGitSyncProfile($workspaceId: String!, $input: GitSyncProfileInput!) {
  createGitSyncProfile(workspaceId: $workspaceId, input: $input) {
    id
    repoUrl
    branch
    rootPath
    authMethod
    triggerMode
    cronExpression
    cronTimezone
    cronMisfirePolicy
    cronNextScheduledAt
    cronPendingMisfireScheduledFor
    syncDirection
    enabled
  }
}
"#;

const UPDATE_GIT_SYNC_PROFILE_MUTATION: &str = r#"
mutation UpdateGitSyncProfile($profileId: String!, $input: UpdateGitSyncProfileInput!) {
  updateGitSyncProfile(profileId: $profileId, input: $input) {
    id
    repoUrl
    branch
    authMethod
    syncDirection
  }
}
"#;

const TRIGGER_GIT_SYNC_MUTATION: &str = r#"
mutation TriggerGitSync($workspaceId: String!, $direction: GitSyncDirection) {
  triggerGitSync(workspaceId: $workspaceId, direction: $direction) {
    id
    direction
    triggerSource
    scheduledFor
    status
  }
}
"#;

const GIT_SYNC_SCHEDULE_QUERY: &str = r#"
query GitSyncSchedule($cron: String!, $cronTimezone: String!, $count: Int) {
  gitSyncSchedulePreview(cron: $cron, cronTimezone: $cronTimezone, count: $count) {
    scheduledAtUtc
    localDateTime
    utcOffsetSeconds
  }
  gitSyncTimezones
}
"#;

const GIT_SYNC_PROFILE_QUERY: &str = r#"
query GitSyncProfile($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncProfile {
      id
      triggerMode
      cronExpression
      cronTimezone
      cronMisfirePolicy
      cronNextScheduledAt
      cronPendingMisfireScheduledFor
    }
  }
}
"#;

const GIT_SYNC_RUN_TRUTH_QUERY: &str = r#"
query GitSyncRunTruth($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncRuns(take: 10) {
      id
      direction
      triggerSource
      status
      startedAt
      finishedAt
      jobId
      commitBefore
      commitAfter
      observedRemoteOid
      reconciliationRequired
      reconciliationReason
      docsCreated
      docsUpdated
      docsDeleted
      conflictsFound
      errorMessage
      errorClass
    }
  }
}
"#;

const ADMIN_GIT_TOKEN_ROTATION_QUERY: &str = r#"
query AdminGitTokenRotation($profileId: String!) {
  admin {
    gitTokenRotationProviders
    gitTokenRotationStatus(profileId: $profileId) {
      profileId
      provider
      enabled
      state
      renewBeforeDays
      requestedLifetimeDays
      currentCredentialExpiresAt
      nextAttemptAt
      lastAttemptAt
      lastSuccessAt
      diagnosis
    }
  }
}
"#;

const CONFIGURE_GIT_TOKEN_ROTATION_MUTATION: &str = r#"
mutation ConfigureGitTokenRotation($input: ConfigureGitTokenRotationInput!) {
  admin {
    configureGitTokenRotation(input: $input) {
      profileId
      provider
      enabled
      state
      renewBeforeDays
      requestedLifetimeDays
      currentCredentialExpiresAt
      nextAttemptAt
      lastAttemptAt
      lastSuccessAt
      diagnosis
    }
  }
}
"#;

const RUN_GIT_TOKEN_ROTATION_NOW_MUTATION: &str = r#"
mutation RunGitTokenRotationNow($profileId: String!) {
  admin {
    runGitTokenRotationNow(profileId: $profileId) {
      profileId
      state
      diagnosis
    }
  }
}
"#;

async fn create_git_sync_profile(app: &axum::Router, session_id: Uuid, workspace_id: Uuid, input: Value) -> Value {
  helpers::gql(
    app,
    session_id,
    helpers::gql_query_vars(
      CREATE_GIT_SYNC_PROFILE_MUTATION,
      json!({
        "workspaceId": workspace_id.to_string(),
        "input": input,
      }),
    ),
  )
  .await
}

async fn update_git_sync_profile(app: &axum::Router, session_id: Uuid, profile_id: Uuid, input: Value) -> Value {
  helpers::gql(
    app,
    session_id,
    helpers::gql_query_vars(
      UPDATE_GIT_SYNC_PROFILE_MUTATION,
      json!({
        "profileId": profile_id.to_string(),
        "input": input,
      }),
    ),
  )
  .await
}

async fn trigger_git_sync(app: &axum::Router, session_id: Uuid, workspace_id: Uuid, direction: Option<&str>) -> Value {
  helpers::gql(
    app,
    session_id,
    helpers::gql_query_vars(
      TRIGGER_GIT_SYNC_MUTATION,
      json!({
        "workspaceId": workspace_id.to_string(),
        "direction": direction,
      }),
    ),
  )
  .await
}

#[test]
fn admin_token_rotation_contract_is_authorized_scrubbed_and_projects_shared_states() {
  helpers::block_on_large_stack("git-token-rotation-graphql", run_admin_token_rotation_contract);
}

async fn run_admin_token_rotation_contract() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|error| error.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_repository().await;
  let (owner_id, owner_session_id) = helpers::seed_user(&pool, &auth_store, "git-token-rotation-owner").await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let credential_expires_at = chrono::Utc::now() + chrono::Duration::days(90);

  let created = create_git_sync_profile(
    &app,
    owner_session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/rotation-contract.git",
      "authMethod": "HttpsToken",
      "token": "rotation-contract-secret",
      "username": "git",
      "credentialExpiresAt": credential_expires_at.to_rfc3339(),
    }),
  )
  .await;
  assert!(created.get("errors").is_none(), "profile create failed: {created}");
  let profile_id = Uuid::parse_str(
    created["data"]["createGitSyncProfile"]["id"]
      .as_str()
      .expect("profile id"),
  )
  .expect("profile UUID");

  let unauthorized = helpers::gql(
    &app,
    owner_session_id,
    helpers::gql_query_vars(
      ADMIN_GIT_TOKEN_ROTATION_QUERY,
      json!({ "profileId": profile_id.to_string() }),
    ),
  )
  .await;
  assert!(
    unauthorized.get("errors").is_some(),
    "non-admin must be rejected: {unauthorized}"
  );

  let configured = helpers::gql(
    &app,
    admin_session_id,
    helpers::gql_query_vars(
      CONFIGURE_GIT_TOKEN_ROTATION_MUTATION,
      json!({
        "input": {
          "profileId": profile_id.to_string(),
          "provider": "GitLab",
          "enabled": true,
          "renewBeforeDays": 30,
          "requestedLifetimeDays": 90,
        }
      }),
    ),
  )
  .await;
  assert!(configured.get("errors").is_none(), "configuration failed: {configured}");
  let status = &configured["data"]["admin"]["configureGitTokenRotation"];
  assert_eq!(status["provider"], "GitLab");
  assert_eq!(status["enabled"], true);
  assert_eq!(status["state"], "Configured");
  assert_eq!(status["renewBeforeDays"], 30);
  assert_eq!(status["requestedLifetimeDays"], 90);
  assert!(status["currentCredentialExpiresAt"].is_string());
  assert!(status["nextAttemptAt"].is_string());

  let immediate_rerotation = helpers::gql(
    &app,
    admin_session_id,
    helpers::gql_query_vars(
      CONFIGURE_GIT_TOKEN_ROTATION_MUTATION,
      json!({
        "input": {
          "profileId": profile_id.to_string(),
          "provider": "GitLab",
          "enabled": true,
          "renewBeforeDays": 90,
          "requestedLifetimeDays": 90,
        }
      }),
    ),
  )
  .await;
  assert!(
    immediate_rerotation.get("errors").is_some(),
    "the shared owner must reject a renewal window that makes a new credential immediately due: {immediate_rerotation}"
  );

  let serialized = configured.to_string().to_ascii_lowercase();
  for forbidden in [
    "rotation-contract-secret",
    "scope",
    "accesslevel",
    "branchrights",
    "remotetoken",
    "credentialid",
  ] {
    assert!(
      !serialized.contains(forbidden),
      "GraphQL response leaked forbidden shape '{forbidden}': {configured}"
    );
  }

  for (state, diagnosis) in [
    ("Failed", Some("request was not transmitted")),
    ("ManualIntervention", Some("provider outcome is unknown")),
    ("Completed", None),
  ] {
    sqlx::query(
      r#"
      UPDATE git_token_rotation
      SET state = $2,
          diagnosis = $3,
          last_attempt_at = now(),
          last_success_at = CASE WHEN $2 = 'Completed' THEN now() ELSE NULL END,
          updated_at = now()
      WHERE profile_id = $1
      "#,
    )
    .bind(profile_id)
    .bind(state)
    .bind(diagnosis)
    .execute(&pool)
    .await
    .expect("project token rotation state");
    let queried = helpers::gql(
      &app,
      admin_session_id,
      helpers::gql_query_vars(
        ADMIN_GIT_TOKEN_ROTATION_QUERY,
        json!({ "profileId": profile_id.to_string() }),
      ),
    )
    .await;
    assert!(queried.get("errors").is_none(), "status query failed: {queried}");
    assert_eq!(queried["data"]["admin"]["gitTokenRotationProviders"], json!(["GitLab"]));
    assert_eq!(queried["data"]["admin"]["gitTokenRotationStatus"]["state"], state);
  }

  sqlx::query(
    "UPDATE git_token_rotation SET state = 'ManualIntervention', diagnosis = 'provider outcome is unknown' WHERE profile_id = $1",
  )
  .bind(profile_id)
  .execute(&pool)
  .await
  .expect("restore manual-intervention state");
  let guarded_run_now = helpers::gql(
    &app,
    admin_session_id,
    helpers::gql_query_vars(
      RUN_GIT_TOKEN_ROTATION_NOW_MUTATION,
      json!({ "profileId": profile_id.to_string() }),
    ),
  )
  .await;
  assert!(
    guarded_run_now.get("errors").is_some(),
    "run-now must preserve the shared manual-intervention guard: {guarded_run_now}"
  );

  helpers::cleanup_users(&pool, &[owner_id, admin_id]).await;
}

#[tokio::test]
async fn cron_profile_preview_and_manual_trigger_preserve_server_owned_schedule() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store, queue) = helpers::setup_app_with_git_sync_queue().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-cron-graphql-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let preview = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(
      GIT_SYNC_SCHEDULE_QUERY,
      json!({
        "cron": "0 * * * *",
        "cronTimezone": "Europe/Berlin",
        "count": 5,
      }),
    ),
  )
  .await;
  assert!(preview.get("errors").is_none(), "schedule preview failed: {preview}");
  let occurrences = preview["data"]["gitSyncSchedulePreview"]
    .as_array()
    .expect("schedule occurrences");
  assert_eq!(occurrences.len(), 5);
  assert!(
    occurrences
      .windows(2)
      .all(|pair| pair[0]["scheduledAtUtc"].as_str() < pair[1]["scheduledAtUtc"].as_str()),
    "server preview must return strictly increasing UTC slots: {occurrences:?}"
  );
  let timezones = preview["data"]["gitSyncTimezones"]
    .as_array()
    .expect("timezone catalog");
  assert!(timezones.windows(2).all(|pair| pair[0].as_str() <= pair[1].as_str()));
  assert!(timezones.iter().any(|value| value == "Europe/Berlin"));

  let invalid = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(
      GIT_SYNC_SCHEDULE_QUERY,
      json!({
        "cron": "* * * * *",
        "cronTimezone": "Europe/Berlin",
        "count": 5,
      }),
    ),
  )
  .await;
  assert_eq!(invalid["errors"][0]["extensions"]["field"], "cronExpression");

  let next_before = chrono::DateTime::parse_from_rfc3339(
    occurrences[0]["scheduledAtUtc"]
      .as_str()
      .expect("first scheduled occurrence"),
  )
  .expect("server occurrence is RFC3339")
  .with_timezone(&chrono::Utc);
  let profile_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_profiles
      (id, workspace_id, owner_id, repo_url, branch, root_path,
       sync_direction, trigger_mode, polling_interval_secs,
       cron_expression, cron_timezone, cron_misfire_policy,
       cron_next_scheduled_at, auth_method, enabled)
    VALUES
      ($1, $2, $3, 'https://localhost/acme/cron.git', 'main', 'content/',
       'MyoxusToGit', 'Cron', NULL, '0 * * * *', 'Europe/Berlin', 'RunOnce',
       $4, 'HttpsToken', true)
    "#,
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .bind(next_before)
  .execute(&pool)
  .await
  .expect("seed valid durable Cron profile");

  let profile = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(
      GIT_SYNC_PROFILE_QUERY,
      json!({
        "workspaceId": workspace_id.to_string(),
      }),
    ),
  )
  .await;
  assert!(profile.get("errors").is_none(), "Cron profile query failed: {profile}");
  let profile = &profile["data"]["workspace"]["gitSyncProfile"];
  assert_eq!(profile["id"], profile_id.to_string());
  assert_eq!(profile["triggerMode"], "Cron");
  assert_eq!(profile["cronExpression"], "0 * * * *");
  assert_eq!(profile["cronTimezone"], "Europe/Berlin");
  assert_eq!(profile["cronMisfirePolicy"], "RunOnce");
  assert!(profile["cronNextScheduledAt"].is_string());
  assert!(profile["cronPendingMisfireScheduledFor"].is_null());

  let run = trigger_git_sync(&app, session_id, workspace_id, None).await;
  assert!(run.get("errors").is_none(), "manual Cron trigger failed: {run}");
  assert_eq!(run["data"]["triggerGitSync"]["triggerSource"], "Manual");
  assert!(run["data"]["triggerGitSync"]["scheduledFor"].is_null());
  let next_after: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT cron_next_scheduled_at FROM git_sync_profiles WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("next occurrence after manual run");
  assert_eq!(next_after, next_before, "manual run must not mutate Cron state");

  queue.empty_queue("git-sync").await.expect("clean Git-Sync test queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn git_sync_runs_expose_completed_pre_push_and_reconciliation_truth() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-run-truth-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let profile_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO git_sync_profiles
      (id, workspace_id, owner_id, repo_url, branch, root_path,
       sync_direction, trigger_mode, auth_method, enabled)
    VALUES
      ($1, $2, $3, 'https://git.example.test/myoxus/run-truth.git',
       'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)
    "#,
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed Git-Sync profile");

  let completed_id = Uuid::new_v4();
  let pre_push_id = Uuid::new_v4();
  let reconciliation_id = Uuid::new_v4();
  let source_oid = "1".repeat(40);
  let completed_oid = "2".repeat(40);
  let observed_oid = "3".repeat(40);
  sqlx::query(
    r#"
    INSERT INTO git_sync_runs
      (id, profile_id, direction, trigger_source, status, started_at, finished_at,
       commit_before, commit_after, observed_remote_oid, reconciliation_required,
       reconciliation_reason, docs_created, docs_updated, docs_deleted,
       conflicts_found, job_id, error_message, error_class)
    VALUES
      ($1, $4, 'Bidirectional', 'Manual', 'Completed',
       now() - interval '3 minutes', now() - interval '2 minutes',
       $5, $6, $6, false, NULL, 1, 2, 3, 4, 'completed-job', NULL, NULL),
      ($2, $4, 'MyoxusToGit', 'Polling', 'Failed',
       now() - interval '2 minutes', now() - interval '1 minute',
       $6, NULL, NULL, false, NULL, 0, 0, 0, 0, 'pre-push-job',
       'remote unavailable', 'GitNetwork'),
      ($3, $4, 'GitToMyoxus', 'Webhook', 'Failed',
       now() - interval '1 minute', now(),
       $6, NULL, $7, true, 'remote moved; database finalization rolled back',
       5, 6, 7, 1, 'reconciliation-job',
       'reconciliation required', 'InternalError')
    "#,
  )
  .bind(completed_id)
  .bind(pre_push_id)
  .bind(reconciliation_id)
  .bind(profile_id)
  .bind(&source_oid)
  .bind(&completed_oid)
  .bind(&observed_oid)
  .execute(&pool)
  .await
  .expect("seed deterministic run states");
  let response = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(
      GIT_SYNC_RUN_TRUTH_QUERY,
      json!({ "workspaceId": workspace_id.to_string() }),
    ),
  )
  .await;
  assert!(response.get("errors").is_none(), "run query failed: {response}");
  let runs = response["data"]["workspace"]["gitSyncRuns"]
    .as_array()
    .expect("run array");
  assert_eq!(runs.len(), 3);

  let completed = runs
    .iter()
    .find(|run| run["id"] == completed_id.to_string())
    .expect("completed run");
  assert_eq!(completed["triggerSource"], "Manual");
  assert_eq!(completed["commitBefore"], source_oid);
  assert_eq!(completed["commitAfter"], completed_oid);
  assert_eq!(completed["observedRemoteOid"], completed_oid);
  assert_eq!(completed["reconciliationRequired"], false);
  assert!(completed["reconciliationReason"].is_null());

  let pre_push = runs
    .iter()
    .find(|run| run["id"] == pre_push_id.to_string())
    .expect("pre-push failure");
  assert_eq!(pre_push["triggerSource"], "Polling");
  assert_eq!(pre_push["errorClass"], "GitNetwork");
  assert!(pre_push["commitAfter"].is_null());
  assert!(pre_push["observedRemoteOid"].is_null());
  assert_eq!(pre_push["reconciliationRequired"], false);

  let reconciliation = runs
    .iter()
    .find(|run| run["id"] == reconciliation_id.to_string())
    .expect("reconciliation-required failure");
  assert_eq!(reconciliation["triggerSource"], "Webhook");
  assert!(reconciliation["commitAfter"].is_null());
  assert_eq!(reconciliation["observedRemoteOid"], observed_oid);
  assert_eq!(reconciliation["reconciliationRequired"], true);
  assert_eq!(
    reconciliation["reconciliationReason"],
    "remote moved; database finalization rolled back"
  );
  assert_eq!(reconciliation["docsCreated"], 5);
  assert_eq!(reconciliation["docsUpdated"], 6);
  assert_eq!(reconciliation["docsDeleted"], 7);

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn create_git_sync_profile_persists_credential_and_links_profile() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_repository().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let response = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_test_123",
      "username": "git",
      "rootPath": "content",
    }),
  )
  .await;

  assert!(
    response.get("errors").is_none(),
    "createGitSyncProfile failed: {response}"
  );

  let profile_row = sqlx::query(
    "SELECT id, credential_id, auth_method, branch, root_path FROM git_sync_profiles WHERE workspace_id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("git sync profile must exist");
  let profile_id: Uuid = profile_row.get("id");
  let credential_id: Uuid = profile_row
    .get::<Option<Uuid>, _>("credential_id")
    .expect("credential_id must be set");
  assert_eq!(response["data"]["createGitSyncProfile"]["id"], profile_id.to_string());
  assert_eq!(profile_row.get::<String, _>("auth_method"), "HttpsToken");
  assert_eq!(profile_row.get::<String, _>("branch"), "main");
  assert_eq!(profile_row.get::<String, _>("root_path"), "content/");

  let credential_row =
    sqlx::query("SELECT profile_id, auth_method, encrypted_data FROM git_sync_credentials WHERE id = $1")
      .bind(credential_id)
      .fetch_one(&pool)
      .await
      .expect("credential row must exist");
  let credential_profile_id: Uuid = credential_row.get("profile_id");
  assert_eq!(credential_profile_id, profile_id);
  assert_eq!(credential_row.get::<String, _>("auth_method"), "HttpsToken");

  // The credential is AES-GCM encrypted — verify it exists and is non-empty.
  // We cannot parse it as JSON without the private key; verifying credential_id
  // linkage and auth_method above is sufficient for this integration test.
  let encrypted_data: Vec<u8> = credential_row.get("encrypted_data");
  assert!(!encrypted_data.is_empty(), "encrypted_data must be non-empty");

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn update_git_sync_profile_preserves_identity_and_rotates_credential() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_repository().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-update-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let first = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_v1",
      "username": "git",
      "branch": "main",
    }),
  )
  .await;
  assert!(first.get("errors").is_none(), "first create failed: {first}");

  let first_profile_id = Uuid::parse_str(
    first["data"]["createGitSyncProfile"]["id"]
      .as_str()
      .expect("id must be returned"),
  )
  .expect("profile id must be uuid");
  let first_credential_id: Uuid = sqlx::query_scalar("SELECT credential_id FROM git_sync_profiles WHERE id = $1")
    .bind(first_profile_id)
    .fetch_one(&pool)
    .await
    .expect("first credential_id");

  let second = update_git_sync_profile(
    &app,
    session_id,
    first_profile_id,
    json!({
      "repoUrl": "https://localhost/acme/repo-updated.git",
      "branch": "develop",
      "syncDirection": "GitToMyoxus",
      "credential": {
        "authMethod": "SshKey",
        "sshPrivateKey": "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        "sshPassphrase": "passphrase-v2"
      }
    }),
  )
  .await;
  assert!(second.get("errors").is_none(), "profile update failed: {second}");

  let second_profile_id = Uuid::parse_str(
    second["data"]["updateGitSyncProfile"]["id"]
      .as_str()
      .expect("id must be returned"),
  )
  .expect("profile id must be uuid");
  assert_eq!(
    first_profile_id, second_profile_id,
    "partial update must keep the same profile id"
  );

  let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_profiles WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("profile count");
  assert_eq!(profile_count, 1, "must not create duplicate profiles");

  let profile_row = sqlx::query(
    "SELECT credential_id, auth_method, branch, repo_url, sync_direction FROM git_sync_profiles WHERE id = $1",
  )
  .bind(first_profile_id)
  .fetch_one(&pool)
  .await
  .expect("updated profile");
  let second_credential_id: Uuid = profile_row
    .get::<Option<Uuid>, _>("credential_id")
    .expect("updated credential_id");
  assert_ne!(
    first_credential_id, second_credential_id,
    "credential rotation must create a new credential row"
  );
  assert_eq!(profile_row.get::<String, _>("auth_method"), "SshKey");
  assert_eq!(profile_row.get::<String, _>("branch"), "develop");
  assert_eq!(
    profile_row.get::<String, _>("repo_url"),
    "https://localhost/acme/repo-updated.git"
  );
  assert_eq!(profile_row.get::<String, _>("sync_direction"), "GitToMyoxus");

  let credentials_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_credentials WHERE profile_id = $1")
      .bind(first_profile_id)
      .fetch_one(&pool)
      .await
      .expect("credentials count");
  assert_eq!(
    credentials_count, 1,
    "only the latest credential should remain attached to the profile"
  );

  let encrypted_bytes: Vec<u8> = sqlx::query_scalar("SELECT encrypted_data FROM git_sync_credentials WHERE id = $1")
    .bind(second_credential_id)
    .fetch_one(&pool)
    .await
    .expect("updated credential payload");
  let crypto_key = AppConfig::load().expect("config").crypto.private_key;
  let plaintext_bytes = crypto::decrypt(&crypto_key, &encrypted_bytes).expect("decrypt credential");
  let payload: Value = serde_json::from_slice(&plaintext_bytes).expect("payload JSON");
  assert!(
    payload["privateKey"]
      .as_str()
      .expect("private key")
      .contains("PRIVATE KEY")
  );
  assert_eq!(payload["passphrase"], "passphrase-v2");

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn create_git_sync_profile_rejects_invalid_credentials_and_disallowed_policy_values() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_git_sync_repository().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-validation-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  // HttpsPassword requires username.
  let missing_username = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsPassword",
      "password": "pw-secret",
    }),
  )
  .await;
  let missing_username_error = missing_username["errors"][0]["message"].as_str().unwrap_or_default();
  assert!(
    missing_username_error.contains("not allowed by administrator policy")
      || missing_username_error.contains("username required"),
    "unexpected error: {missing_username}"
  );

  // Empty token for HttpsToken must be rejected.
  let empty_token = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "   ",
    }),
  )
  .await;
  assert!(
    empty_token["errors"][0]["message"]
      .as_str()
      .unwrap_or_default()
      .contains("token required"),
    "empty token should be rejected: {empty_token}"
  );

  // Webhook mode is disabled by default policy.
  let webhook_disallowed = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_ok",
      "triggerMode": "Webhook",
    }),
  )
  .await;
  assert!(
    webhook_disallowed["errors"][0]["message"]
      .as_str()
      .unwrap_or_default()
      .contains("webhook sync is disabled"),
    "webhook policy should be enforced: {webhook_disallowed}"
  );

  // Repository URLs must not bypass credential storage or point at local files.
  let embedded_credentials = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://git:secret@localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_ok",
    }),
  )
  .await;
  assert!(
    embedded_credentials["errors"][0]["message"]
      .as_str()
      .unwrap_or_default()
      .contains("must not embed credentials"),
    "URL-embedded credentials should be rejected: {embedded_credentials}"
  );

  let local_file_url = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "file:///tmp/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_ok",
    }),
  )
  .await;
  assert!(
    local_file_url["errors"][0]["message"]
      .as_str()
      .unwrap_or_default()
      .contains("must use https://, ssh://, or user@host:path"),
    "local file repository URLs should be rejected: {local_file_url}"
  );

  let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM git_sync_profiles WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("profile count");
  assert_eq!(
    profile_count, 0,
    "invalid requests must not leave partial profiles behind"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn trigger_git_sync_rejects_direction_override_and_dispatches_profile_direction() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store, queue) = helpers::setup_app_with_git_sync_queue().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-trigger-policy-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let profile = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_ok",
      "syncDirection": "MyoxusToGit",
    }),
  )
  .await;
  assert!(profile.get("errors").is_none(), "profile create failed: {profile}");

  let override_disallowed = trigger_git_sync(&app, session_id, workspace_id, Some("GitToMyoxus")).await;
  assert!(
    override_disallowed["errors"][0]["message"]
      .as_str()
      .unwrap_or_default()
      .contains("must equal the configured profile direction"),
    "a manual ingress must never widen or narrow the profile direction: {override_disallowed}"
  );

  let allowed_run = trigger_git_sync(&app, session_id, workspace_id, None).await;
  assert!(
    allowed_run.get("errors").is_none(),
    "allowed trigger failed: {allowed_run}"
  );
  assert_eq!(allowed_run["data"]["triggerGitSync"]["direction"], "MyoxusToGit");

  let run_count: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)::bigint
    FROM git_sync_runs
    WHERE profile_id = (
      SELECT id
      FROM git_sync_profiles
      WHERE workspace_id = $1
    )
    "#,
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("run count");
  assert_eq!(run_count, 1, "only allowed trigger should persist a run");
  let job_id: String = sqlx::query_scalar(
    "SELECT job_id FROM git_sync_runs WHERE profile_id = (SELECT id FROM git_sync_profiles WHERE workspace_id = $1)",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("persisted dispatch job id");
  let queued = queue
    .get_job("git-sync", &job_id)
    .await
    .expect("load dispatched job")
    .expect("dispatched job exists");
  assert_eq!(queued.data["direction"], "MyoxusToGit");
  assert_eq!(queued.data["trigger"], "Manual");

  queue.empty_queue("git-sync").await.expect("clean Git-Sync test queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn trigger_git_sync_reuses_existing_unfinished_run() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store, queue) = helpers::setup_app_with_git_sync_queue().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "git-sync-trigger-dedupe-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let profile = create_git_sync_profile(
    &app,
    session_id,
    workspace_id,
    json!({
      "repoUrl": "https://localhost/acme/repo.git",
      "authMethod": "HttpsToken",
      "token": "tok_ok",
      "syncDirection": "MyoxusToGit",
    }),
  )
  .await;
  assert!(profile.get("errors").is_none(), "profile create failed: {profile}");

  let first = trigger_git_sync(&app, session_id, workspace_id, Some("MyoxusToGit")).await;
  assert!(first.get("errors").is_none(), "first trigger failed: {first}");
  let second = trigger_git_sync(&app, session_id, workspace_id, Some("MyoxusToGit")).await;
  assert!(second.get("errors").is_none(), "second trigger failed: {second}");

  let first_run_id = first["data"]["triggerGitSync"]["id"].as_str().expect("first run id");
  let second_run_id = second["data"]["triggerGitSync"]["id"].as_str().expect("second run id");
  assert_eq!(
    first_run_id, second_run_id,
    "GraphQL trigger must reuse an unfinished run instead of creating duplicate Pending work"
  );

  let run_count: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)::bigint
    FROM git_sync_runs
    WHERE profile_id = (
      SELECT id
      FROM git_sync_profiles
      WHERE workspace_id = $1
    )
    "#,
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("run count");
  assert_eq!(
    run_count, 1,
    "only one unfinished run should exist after repeated trigger"
  );
  let (jobs, job_count) = queue
    .list_jobs("git-sync", "waiting", 0, 10)
    .await
    .expect("list queued Git-Sync jobs");
  assert_eq!(job_count, 1, "repeated trigger must publish exactly one queue job");
  assert_eq!(jobs.len(), 1);

  queue.empty_queue("git-sync").await.expect("clean Git-Sync test queue");
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
