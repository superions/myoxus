// SPDX-License-Identifier: AGPL-3.0-or-later
//! Server-side Git-Sync conflict resolution semantics.
//!
//! These tests intentionally go through GraphQL for permission and API contract
//! coverage, then assert the persisted document/baseline side effects directly.

use chrono::Utc;
use myoxus_api::git_sync_engine::loader;
use myoxus_application::git_sync::doc_reconcile_plan;
use myoxus_application::git_sync::export;
use myoxus_application::git_sync::reconcile::{BaselineState, ReconcileAction};
use myoxus_application::markdown::{content_hash, markdown_to_yjs, yjs_to_markdown};
use myoxus_domain::git_sync::{
  AuthMethod, ConflictResolution, ConflictType, GitSyncBaseline, GitSyncBinding, GitSyncConflict, GitSyncProfile,
  SyncDirection, TriggerMode,
};
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::helpers;

struct ConflictFixture {
  user_id: Uuid,
  session_id: Uuid,
  workspace_id: Uuid,
  profile: GitSyncProfile,
  binding: GitSyncBinding,
  conflict_id: Uuid,
}

async fn seed_conflict_fixture(
  pool: &sqlx::PgPool,
  auth_store: &std::sync::Arc<myoxus_infrastructure::auth::SqlxAuthStore>,
) -> ConflictFixture {
  let (user_id, session_id) = helpers::seed_admin(pool, auth_store).await;
  let workspace_id = helpers::create_workspace(pool, user_id).await;
  let doc_id = helpers::create_doc(pool, workspace_id, user_id).await;
  let store = SqlxGitSyncStore::new(pool.clone());
  let now = Utc::now();
  let profile = GitSyncProfile {
    id: Uuid::new_v4(),
    workspace_id,
    owner_id: user_id,
    repo_url: "https://example.test/myoxus/conflict.git".to_string(),
    branch: "main".to_string(),
    root_path: "content/".to_string(),
    manifest_path: myoxus_application::git_sync::export::GIT_SYNC_MANIFEST_PATH.to_string(),
    scope_revision: 0,
    sync_direction: SyncDirection::Bidirectional,
    trigger_mode: TriggerMode::Manual,
    polling_interval_secs: None,
    cron_expression: None,
    cron_timezone: None,
    cron_misfire_policy: None,
    cron_next_scheduled_at: None,
    cron_pending_misfire_scheduled_for: None,
    auth_method: AuthMethod::HttpsToken,
    credential_id: None,
    enabled: true,
    max_mirror_storage_mb: None,
    created_at: now,
    updated_at: now,
  };
  let profile = store.create_profile(&profile).await.expect("create profile");
  let binding = GitSyncBinding {
    id: Uuid::new_v4(),
    profile_id: profile.id,
    workspace_id,
    doc_id,
    sync_id: Uuid::new_v4(),
    repo_path: "content/conflicted.md".to_string(),
    last_commit_oid: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()),
    content_hash: Some(content_hash("# Conflict\n\nMyoxus version\n")),
    structure_hash: None,
    tombstone: false,
    created_at: now,
    updated_at: now,
  };
  let binding = store.create_binding(&binding).await.expect("create binding");
  store
    .upsert_baseline(&GitSyncBaseline {
      binding_id: binding.id,
      content_hash: content_hash("# Conflict\n\nBase version\n"),
      commit_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
      myoxus_updated_at: now,
      captured_at: now,
    })
    .await
    .expect("baseline");
  let myoxus_payload = markdown_to_yjs("Conflict", "# Conflict\n\nMyoxus version\n").expect("myoxus yjs");
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at) VALUES ($1, $2, $3, 1, now())",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(myoxus_payload)
  .execute(pool)
  .await
  .expect("snapshot");

  let git_file = export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id: binding.sync_id,
      doc_id,
      workspace_id,
      title: "Git Conflict".to_string(),
    },
    "# Conflict\n\nGit version\n",
  );
  let conflict = GitSyncConflict {
    id: Uuid::new_v4(),
    profile_id: profile.id,
    binding_id: Some(binding.id),
    doc_id,
    repo_path: binding.repo_path.clone(),
    conflict_type: ConflictType::BothModified,
    resolution: ConflictResolution::Open,
    base_content: Some("# Conflict\n\nBase version\n".to_string()),
    myoxus_content: Some("# Conflict\n\nMyoxus version\n".to_string()),
    git_content: Some(git_file),
    created_at: now,
    resolved_at: None,
    resolved_by: None,
  };
  let conflict = store.create_conflict(&conflict).await.expect("conflict");

  ConflictFixture {
    user_id,
    session_id,
    workspace_id,
    profile,
    binding,
    conflict_id: conflict.id,
  }
}

async fn resolve(
  app: &axum::Router,
  session_id: Uuid,
  conflict_id: Uuid,
  resolution: &str,
  merged_content: Option<&str>,
) -> serde_json::Value {
  helpers::gql(
    app,
    session_id,
    json!({
      "query": "mutation($input: ResolveConflictInput!) { resolveGitSyncConflict(input: $input) }",
      "variables": {
        "input": {
          "conflictId": conflict_id.to_string(),
          "resolution": resolution,
          "mergedContent": merged_content
        }
      }
    }),
  )
  .await
}

async fn snapshot_markdown(pool: &sqlx::PgPool, doc_id: Uuid) -> String {
  let payload: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_snapshots WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .expect("snapshot payload");
  yjs_to_markdown(&payload)
    .expect("convert yjs")
    .expect("markdown result")
    .markdown
}

fn expected_git_body_hash(fx: &ConflictFixture) -> String {
  let git_file = export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id: fx.binding.sync_id,
      doc_id: fx.binding.doc_id,
      workspace_id: fx.workspace_id,
      title: "Git Conflict".to_string(),
    },
    "# Conflict\n\nGit version\n",
  );
  let (_, body) = export::split_markdown_file(&git_file);
  content_hash(&body)
}

fn git_file_for_fixture(fx: &ConflictFixture) -> String {
  export::compose_markdown_file(
    &export::ExportFrontmatter {
      sync_id: fx.binding.sync_id,
      doc_id: fx.binding.doc_id,
      workspace_id: fx.workspace_id,
      title: "Git Conflict".to_string(),
    },
    "# Conflict\n\nGit version\n",
  )
}

async fn assert_next_doc_plan_action(pool: &sqlx::PgPool, fx: &ConflictFixture, expected: ReconcileAction) {
  let store = SqlxGitSyncStore::new(pool.clone());
  let myoxus_docs = loader::load_myoxus_docs(pool, fx.workspace_id)
    .await
    .expect("load myoxus docs")
    .docs;
  let bindings = store.get_bindings_by_profile(fx.profile.id).await.expect("bindings");
  let baselines = store
    .get_baselines_by_profile(fx.profile.id)
    .await
    .expect("baselines")
    .into_iter()
    .map(|baseline| {
      (
        baseline.binding_id,
        BaselineState {
          content_hash: baseline.content_hash,
        },
      )
    })
    .collect::<Vec<_>>();
  let git_files = vec![(fx.binding.repo_path.clone(), git_file_for_fixture(fx))];
  let plan = doc_reconcile_plan::plan_doc_sync(&fx.profile, &myoxus_docs, &bindings, &baselines, &git_files);
  let action = plan
    .actions
    .iter()
    .find(|action| action.doc_id == fx.binding.doc_id)
    .map(|action| action.action.clone())
    .expect("planned action for conflicted doc");
  assert_eq!(
    action, expected,
    "resolved conflict must steer the next reconcile pass instead of recreating a conflict"
  );
}

#[tokio::test]
async fn git_wins_updates_myoxus_snapshot_and_baseline_to_git_content() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let fx = seed_conflict_fixture(&pool, &auth_store).await;

  let resp = resolve(&app, fx.session_id, fx.conflict_id, "GitWins", None).await;
  assert!(resp.get("errors").is_none(), "GitWins must succeed: {resp}");
  assert_eq!(resp["data"]["resolveGitSyncConflict"], true);

  let markdown = snapshot_markdown(&pool, fx.binding.doc_id).await;
  assert!(
    markdown.contains("Git version"),
    "snapshot must contain Git content: {markdown}"
  );
  let baseline_hash: String = sqlx::query_scalar("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("baseline hash");
  assert_eq!(
    baseline_hash,
    content_hash(&markdown),
    "baseline must match the normalized projection read on the next run"
  );
  let binding_hash: Option<String> = sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("binding Git-source hash");
  assert_eq!(binding_hash.as_deref(), Some(expected_git_body_hash(&fx).as_str()));
  let resolution: String = sqlx::query_scalar("SELECT resolution FROM git_sync_conflicts WHERE id = $1")
    .bind(fx.conflict_id)
    .fetch_one(&pool)
    .await
    .expect("resolution");
  assert_eq!(resolution, "GitWins");

  helpers::cleanup_users(&pool, &[fx.user_id]).await;
}

#[tokio::test]
async fn manual_merge_requires_content_and_primes_next_run_to_push_merge() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let fx = seed_conflict_fixture(&pool, &auth_store).await;

  let rejected = resolve(&app, fx.session_id, fx.conflict_id, "ManualMerge", None).await;
  assert!(
    rejected.get("errors").is_some(),
    "ManualMerge without content must fail"
  );

  let merged = "# Conflict\n\nMerged version\n";
  let resp = resolve(&app, fx.session_id, fx.conflict_id, "ManualMerge", Some(merged)).await;
  assert!(resp.get("errors").is_none(), "ManualMerge must succeed: {resp}");

  let markdown = snapshot_markdown(&pool, fx.binding.doc_id).await;
  assert!(
    markdown.contains("Merged version"),
    "snapshot must contain merge: {markdown}"
  );
  let row = sqlx::query("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("baseline");
  let baseline_hash: String = row.get("content_hash");
  assert_eq!(
    baseline_hash,
    content_hash("# Conflict\n\nBase version\n"),
    "normalized Myoxus baseline must remain unchanged so the merge is pushed"
  );
  let binding_hash: Option<String> = sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("binding Git-source hash");
  assert_eq!(binding_hash.as_deref(), Some(expected_git_body_hash(&fx).as_str()));
  assert_next_doc_plan_action(&pool, &fx, ReconcileAction::PushToGit).await;

  helpers::cleanup_users(&pool, &[fx.user_id]).await;
}

#[tokio::test]
async fn myoxus_wins_does_not_rewrite_snapshot_but_primes_push_to_git() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let fx = seed_conflict_fixture(&pool, &auth_store).await;

  let before = snapshot_markdown(&pool, fx.binding.doc_id).await;
  let resp = resolve(&app, fx.session_id, fx.conflict_id, "MyoxusWins", None).await;
  assert!(resp.get("errors").is_none(), "MyoxusWins must succeed: {resp}");
  let after = snapshot_markdown(&pool, fx.binding.doc_id).await;
  assert_eq!(after, before, "MyoxusWins must not rewrite the Myoxus snapshot");

  let baseline_hash: String = sqlx::query_scalar("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("baseline hash");
  assert_eq!(baseline_hash, content_hash("# Conflict\n\nBase version\n"));
  let binding_hash: Option<String> = sqlx::query_scalar("SELECT content_hash FROM git_sync_bindings WHERE id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("binding Git-source hash");
  assert_eq!(binding_hash.as_deref(), Some(expected_git_body_hash(&fx).as_str()));
  assert_next_doc_plan_action(&pool, &fx, ReconcileAction::PushToGit).await;

  helpers::cleanup_users(&pool, &[fx.user_id]).await;
}

#[tokio::test]
async fn dismissed_marks_conflict_without_snapshot_or_baseline_side_effects() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let fx = seed_conflict_fixture(&pool, &auth_store).await;

  let before = snapshot_markdown(&pool, fx.binding.doc_id).await;
  let baseline_before: String = sqlx::query_scalar("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("baseline before");
  let resp = resolve(&app, fx.session_id, fx.conflict_id, "Dismissed", None).await;
  assert!(resp.get("errors").is_none(), "Dismissed must succeed: {resp}");
  let after = snapshot_markdown(&pool, fx.binding.doc_id).await;
  let baseline_after: String = sqlx::query_scalar("SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1")
    .bind(fx.binding.id)
    .fetch_one(&pool)
    .await
    .expect("baseline after");
  assert_eq!(after, before);
  assert_eq!(baseline_after, baseline_before);

  helpers::cleanup_users(&pool, &[fx.user_id]).await;
}

#[tokio::test]
async fn loader_exports_pending_updates_after_the_compacted_snapshot() {
  let (_, pool, auth_store) = helpers::setup_app().await;
  let (user_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, user_id).await;

  let mut builder = yjs::YjsDocumentBuilder::new("Current state");
  builder.push_paragraph(&[yjs::YjsTextSegment::plain("Compacted content")]);
  let snapshot = builder.encode_state();
  let snapshot_vector = builder.state_vector();
  builder.push_paragraph(&[yjs::YjsTextSegment::plain("Pending update content")]);
  let pending_update = builder.encode_diff(&snapshot_vector);

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 0, now())
     ON CONFLICT (doc_id) DO UPDATE
       SET payload = EXCLUDED.payload, last_sequence = 0, updated_at = EXCLUDED.updated_at",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(snapshot)
  .execute(&pool)
  .await
  .expect("seed compacted snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(pending_update)
  .execute(&pool)
  .await
  .expect("seed pending update");

  let mut loaded = loader::load_myoxus_docs(&pool, workspace_id)
    .await
    .expect("load current Git-Sync state");
  loaded.docs.retain(|document| document.doc_id == doc_id);
  loaded.docs[0].planned_repo_path = Some("content/current-state.md".to_string());
  let projection_ids = std::collections::HashSet::from([doc_id]);
  let (captured, selected) = loader::capture_myoxus_docs_in_path_plan(
    &pool,
    workspace_id,
    "https://myoxus.test",
    &loaded.docs,
    &loaded.reference_documents,
    &loaded.reference_external_ids,
    &projection_ids,
  )
  .await
  .expect("capture native projection");
  let (failures, failed_ids, _, _) = loader::project_myoxus_docs_in_path_plan(
    &mut loaded.docs,
    &loaded.reference_external_ids,
    captured,
    &selected,
    10,
    &std::collections::HashMap::new(),
  )
  .await
  .expect("project current Git-Sync state after final path planning");
  assert_eq!((failures, failed_ids), (0, Vec::new()));
  let markdown = loaded
    .docs
    .iter()
    .find(|document| document.doc_id == doc_id)
    .and_then(|document| document.markdown.as_deref())
    .expect("current document Markdown");
  assert!(markdown.contains("Compacted content"), "{markdown}");
  assert!(
    markdown.contains("Pending update content"),
    "Git-Sync must not wait for compaction: {markdown}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}
