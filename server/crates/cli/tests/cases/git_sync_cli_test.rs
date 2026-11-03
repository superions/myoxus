//! Integration coverage for `myoxus-cli git-sync`.
//!
//! These tests drive the compiled CLI binary against PostgreSQL. They focus on
//! operator-visible Git-Sync contracts that previously drifted from GraphQL:
//! doc+file conflict visibility, explicit status counters and trigger dedupe.

use crate::support;

use std::path::Path;
use std::process::{Command, Output};
use std::sync::Arc;

use myoxus_application::doc::DocService;
use myoxus_application::git_sync::ExportFrontmatter;
use myoxus_application::git_sync::export::{GitSyncManifest, GitSyncManifestDocument, compose_markdown_file};
use myoxus_application::markdown::content_hash;
use myoxus_application::organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService};
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use tempfile::{TempDir, tempdir};
use uuid::Uuid;

const TEST_CRYPTO_PRIVATE_KEY: &str = "git-sync-cli-test-private-key";

async fn setup_pool() -> PgPool {
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url())
    .await
    .expect("connect test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("apply migrations for git-sync CLI tests");
  pool
}

fn cli_command(args: &[&str]) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__CRYPTO__PRIVATE_KEY", TEST_CRYPTO_PRIVATE_KEY)
    .arg("--json")
    .args(args);
  command
}

fn cli_output(args: &[&str]) -> Output {
  let storage = tempdir().expect("isolated CLI storage root");
  cli_command(args)
    .env("MYOXUS__STORAGE__ROOT", storage.path())
    .output()
    .expect("run myoxus-cli")
}

fn run_cli(args: &[&str]) -> Value {
  let output = cli_output(args);
  assert_success(&output);
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

/// Keep the simulated dispatcher alive through native startup, but stop polling
/// when its own CLI exits. Only the native post-intent dispatch wait is timed.
async fn run_cli_with_dispatch_ack(pool: &PgPool, profile_id: Uuid) -> Value {
  let args = [
    "git-sync".to_string(),
    "trigger".to_string(),
    profile_id.to_string(),
    "--timeout".to_string(),
    "3".to_string(),
  ];
  let mut child = tokio::task::spawn_blocking(move || {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    cli_output(&borrowed)
  });
  let pending = tokio::select! {
    output = &mut child => {
      let output = output.expect("join native CLI output");
      panic!(
        "CLI exited before its Pending dispatch intent was observed\nstatus: {}\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
      );
    }
    pending = async {
      loop {
        let pending: Option<Uuid> = sqlx::query_scalar(
          "SELECT id FROM git_sync_runs WHERE profile_id = $1 AND status = 'Pending' LIMIT 1",
        )
        .bind(profile_id)
        .fetch_optional(pool)
        .await?;
        if let Some(run_id) = pending {
          break Ok::<Uuid, sqlx::Error>(run_id);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
      }
    } => pending,
  };
  // Persist outside the selected polling future: observing child completion
  // must never cancel an acknowledgement query that may already have committed.
  let acknowledgement = match pending {
    Ok(run_id) => sqlx::query("UPDATE git_sync_runs SET job_id = $2 WHERE id = $1")
      .bind(run_id)
      .bind(format!("git-sync-{run_id}"))
      .execute(pool)
      .await
      .map(|result| result.rows_affected()),
    Err(error) => Err(error),
  };
  // Even a failed observer owns its subprocess until the native bounded wait
  // exits, retaining the private distribution and storage guards in cli_output.
  let output = child.await.expect("join native CLI output");
  assert!(
    matches!(&acknowledgement, Ok(1)),
    "simulated dispatch acknowledgement failed: {acknowledgement:?}\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr),
  );
  assert_success(&output);
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

fn run_cli_failure(args: &[&str]) -> String {
  let output = cli_output(args);
  assert!(
    !output.status.success(),
    "CLI unexpectedly succeeded\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  String::from_utf8_lossy(&output.stderr).into_owned()
}

fn run_cli_failure_output(args: &[&str]) -> Output {
  let output = cli_output(args);
  assert!(
    !output.status.success(),
    "CLI unexpectedly succeeded\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  output
}

fn assert_success(output: &Output) {
  assert!(
    output.status.success(),
    "CLI failed\nstatus: {}\nstdout: {}\nstderr: {}",
    output.status,
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
}

fn git(dir: &Path, args: &[&str]) -> String {
  let output = Command::new("git")
    .args(args)
    .current_dir(dir)
    .env("GIT_TERMINAL_PROMPT", "0")
    .output()
    .unwrap_or_else(|error| panic!("failed to run git {}: {error}", args.join(" ")));
  assert!(
    output.status.success(),
    "git {} failed in {}\nstdout: {}\nstderr: {}",
    args.join(" "),
    dir.display(),
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn init_reconciliation_remote() -> (TempDir, TempDir, String) {
  let bare = tempdir().expect("bare repository");
  git(bare.path(), &["init", "--bare", "--initial-branch=main"]);
  let work = tempdir().expect("work repository");
  git(work.path(), &["init", "--initial-branch=main"]);
  git(work.path(), &["config", "user.email", "git-sync-cli@test.local"]);
  git(work.path(), &["config", "user.name", "Git Sync CLI Test"]);
  let remote_url = format!("file://{}", bare.path().display());
  git(work.path(), &["remote", "add", "origin", &remote_url]);
  (bare, work, remote_url)
}

fn write_reconciliation_remote(
  work: &TempDir,
  workspace_id: Uuid,
  documents: &[(Uuid, Uuid, &str, &str, &str)],
  message: &str,
) -> String {
  let mut manifest_documents = Vec::new();
  for (doc_id, sync_id, title, repo_path, body) in documents {
    let path = work.path().join(repo_path);
    std::fs::create_dir_all(path.parent().expect("document parent")).expect("create document parent");
    let frontmatter = ExportFrontmatter {
      sync_id: *sync_id,
      doc_id: *doc_id,
      workspace_id,
      title: (*title).to_string(),
    };
    std::fs::write(&path, compose_markdown_file(&frontmatter, body)).expect("write remote document");
    manifest_documents.push(GitSyncManifestDocument {
      doc_id: *doc_id,
      organizer_entry_id: None,
      organizer_folder_ids: Vec::new(),
      repo_path: (*repo_path).to_string(),
      title: (*title).to_string(),
      content_hash: content_hash(body),
    });
  }
  let control = work.path().join(".myoxus");
  std::fs::create_dir_all(&control).expect("create control directory");
  let manifest = GitSyncManifest::new(workspace_id, "cli-fixture".to_string(), Vec::new(), manifest_documents);
  std::fs::write(
    control.join("git-sync-manifest.json"),
    manifest.to_json().expect("serialize manifest"),
  )
  .expect("write manifest");
  git(work.path(), &["add", "."]);
  git(work.path(), &["commit", "-m", message]);
  git(work.path(), &["push", "-u", "origin", "main"]);
  git(work.path(), &["rev-parse", "HEAD"])
}

#[tokio::test]
async fn inv_cli_gitsync_bootstrap_is_guarded_complete_and_converges_to_no_op() {
  let pool = setup_pool().await;
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let profile_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let external_id = "BootstrapNanoPlacement8kR";
  let (bare, work, remote_url) = init_reconciliation_remote();
  std::fs::create_dir_all(work.path().join("content")).expect("create managed root");
  std::fs::create_dir_all(work.path().join("content/child/.myoxus")).expect("create detached child root");
  std::fs::write(work.path().join("content/child/README.md"), "# Child overview\n").expect("write child overview");
  std::fs::write(work.path().join("content/child/note.md"), "# Child content\n").expect("write child content");
  std::fs::write(
    work.path().join("content/child/.myoxus/git-sync-manifest.json"),
    "{\"child\":\"owns this subtree\"}\n",
  )
  .expect("write child manifest");
  std::fs::create_dir_all(work.path().join(".myoxus")).expect("create control root");
  std::fs::write(work.path().join("content/stale.md"), "# stale\n").expect("write stale markdown");
  std::fs::write(work.path().join("README.txt"), "outside managed root\n").expect("write outside-root content");
  std::fs::write(
    work.path().join(".myoxus/git-sync-manifest.json"),
    serde_json::to_vec_pretty(&serde_json::json!({
      "schemaVersion": 1,
      "exporterVersion": "stale",
      "workspaceId": workspace_id,
      "organizerRevision": "stale",
      "folders": [],
      "documents": []
    }))
    .unwrap(),
  )
  .expect("write stale manifest");
  git(work.path(), &["add", "."]);
  git(work.path(), &["commit", "-m", "stale bootstrap fixture"]);
  git(work.path(), &["push", "-u", "origin", "main"]);
  let initial_oid = git(work.path(), &["rev-parse", "HEAD"]);

  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'Bootstrap CLI', now())")
    .bind(user_id)
    .bind(format!("bootstrap-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("insert bootstrap user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, 'Bootstrap CLI', false)")
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert bootstrap workspace");
  sqlx::query("INSERT INTO docs (id, external_id, workspace_id, title) VALUES ($1, $2, $3, 'Empty')")
    .bind(doc_id)
    .bind(external_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("insert empty bootstrap document");
  let organizer = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  organizer
    .create_folder(
      workspace_id,
      CreateOrganizerFolder {
        id: "bootstrap-folder".to_string(),
        parent_id: None,
        name: "Nano folder".to_string(),
        index: Some("a0".to_string()),
      },
    )
    .await
    .expect("create bootstrap Organizer folder");
  organizer
    .create_link(
      workspace_id,
      CreateOrganizerLink {
        id: "bootstrap-entry".to_string(),
        parent_id: "bootstrap-folder".to_string(),
        link_type: OrganizerLinkType::Doc,
        target_id: external_id.to_string(),
        target_workspace_id: None,
        index: Some("a0".to_string()),
      },
    )
    .await
    .expect("create NanoID Organizer link");
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, $4, 'main', 'content/', 'MyoxusToGit',
             'Manual', 'HttpsToken', false)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(user_id)
  .bind(&remote_url)
  .execute(&pool)
  .await
  .expect("insert disabled bootstrap profile");
  let credential_id = Uuid::new_v4();
  let credential = myoxus_infrastructure::crypto::encrypt(TEST_CRYPTO_PRIVATE_KEY, br#"{"token":"local-fixture"}"#)
    .expect("encrypt bootstrap credential");
  sqlx::query(
    "INSERT INTO git_sync_credentials (id, profile_id, auth_method, label, encrypted_data)
     VALUES ($1, $2, 'HttpsToken', 'Bootstrap fixture', $3)",
  )
  .bind(credential_id)
  .bind(profile_id)
  .bind(credential)
  .execute(&pool)
  .await
  .expect("insert bootstrap credential");
  sqlx::query("UPDATE git_sync_profiles SET credential_id = $2 WHERE id = $1")
    .bind(profile_id)
    .bind(credential_id)
    .execute(&pool)
    .await
    .expect("bind bootstrap credential");
  let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
  store
    .add_scope_exclusion(profile_id, "content/child", true, None, Uuid::new_v4(), 0)
    .await
    .expect("keep the detached child's ownership fence");

  let remote_before = git(bare.path(), &["rev-parse", "refs/heads/main"]);
  let attempts_before: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_bootstrap_attempts WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("count attempts before dry-run");
  let dry_run = run_cli(&["git-sync", "bootstrap", &profile_id.to_string()]);
  assert_eq!(dry_run["attempt"], Value::Null);
  assert_eq!(dry_run["report"]["expectedRemoteOid"], initial_oid);
  assert_eq!(dry_run["report"]["documents"], 1);
  assert!(
    dry_run["report"]["writes"]
      .as_array()
      .unwrap()
      .iter()
      .any(|path| path == "content/nano-folder/empty.md")
  );
  assert_eq!(dry_run["report"]["deletes"], serde_json::json!(["content/stale.md"]));
  for path in [
    "content/child/README.md",
    "content/child/note.md",
    "content/child/.myoxus/git-sync-manifest.json",
  ] {
    assert!(
      !dry_run["report"]["writes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry == path)
        && !dry_run["report"]["deletes"]
          .as_array()
          .unwrap()
          .iter()
          .any(|entry| entry == path),
      "bootstrap may not plan a write or deletion inside the detached child: {path}"
    );
  }
  assert_eq!(git(bare.path(), &["rev-parse", "refs/heads/main"]), remote_before);
  let attempts_after_dry_run: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_bootstrap_attempts WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("count attempts after dry-run");
  assert_eq!(attempts_after_dry_run, attempts_before);

  let wrong_oid = "0".repeat(40);
  let wrong = run_cli_failure(&[
    "git-sync",
    "bootstrap",
    &profile_id.to_string(),
    "--apply",
    "--expected-remote-oid",
    &wrong_oid,
  ]);
  assert!(wrong.contains("remote branch moved"), "{wrong}");
  let attempts_after_wrong_oid: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_bootstrap_attempts WHERE profile_id = $1")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("count attempts after wrong OID");
  assert_eq!(attempts_after_wrong_oid, attempts_before);

  let applied = run_cli(&[
    "git-sync",
    "bootstrap",
    &profile_id.to_string(),
    "--apply",
    "--expected-remote-oid",
    &initial_oid,
  ]);
  assert_eq!(applied["attempt"]["phase"], "Completed");
  assert_eq!(applied["report"]["noOp"], true);
  assert_ne!(git(bare.path(), &["rev-parse", "refs/heads/main"]), initial_oid);
  assert!(
    !git(bare.path(), &["ls-tree", "-r", "--name-only", "main"])
      .lines()
      .any(|path| path == "content/stale.md")
  );
  assert_eq!(git(bare.path(), &["show", "main:README.txt"]), "outside managed root");
  for path in [
    "content/child/README.md",
    "content/child/note.md",
    "content/child/.myoxus/git-sync-manifest.json",
  ] {
    assert_eq!(
      git(bare.path(), &["show", &format!("main:{path}")]),
      git(work.path(), &["show", &format!("{initial_oid}:{path}")]),
      "bootstrap must preserve the child bytes: {path}"
    );
  }
  assert!(
    git(bare.path(), &["show", "main:content/nano-folder/empty.md"]).contains("title: \"Empty\""),
    "documents must be materialized as first-class Markdown"
  );

  let manifest: Value = serde_json::from_str(&git(bare.path(), &["show", "main:.myoxus/git-sync-manifest.json"]))
    .expect("bootstrap manifest JSON");
  let manifest_document = manifest["documents"]
    .as_array()
    .expect("bootstrap manifest documents")
    .iter()
    .find(|document| document["docId"] == doc_id.to_string())
    .expect("NanoID-linked bootstrap manifest document");
  assert_eq!(manifest_document["organizerEntryId"], "bootstrap-entry");
  assert_eq!(
    manifest_document["organizerFolderIds"],
    serde_json::json!(["bootstrap-folder"])
  );
  assert_eq!(manifest_document["repoPath"], "content/nano-folder/empty.md");
  let typed: GitSyncManifest = serde_json::from_value(manifest.clone()).unwrap();
  for output in typed.overview_outputs() {
    let bytes = git(bare.path(), &["show", &format!("main:{}", output.repo_path)]);
    // The command helper trims the final newline; verify the stored blob bytes.
    let raw = Command::new("git")
      .arg("-C")
      .arg(bare.path())
      .args(["show", &format!("main:{}", output.repo_path)])
      .output()
      .unwrap();
    assert!(raw.status.success());
    myoxus_application::git_sync::overview::verify_git_overview_bytes(&raw.stdout, &output.content_hash).unwrap();
    assert!(
      dry_run["report"]["writes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|path| path == &output.repo_path)
    );
    assert!(bytes.contains("## Documents"));
  }
  assert!(typed.overview.is_some());
  let bound_doc_id: Uuid =
    sqlx::query_scalar("SELECT doc_id FROM git_sync_bindings WHERE profile_id = $1 AND tombstone = false")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .expect("bootstrap binding internal document UUID");
  assert_eq!(bound_doc_id, doc_id);

  let active_bindings: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_bindings WHERE profile_id = $1 AND tombstone = false")
      .bind(profile_id)
      .fetch_one(&pool)
      .await
      .unwrap();
  let baselines: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM git_sync_baselines bl
     JOIN git_sync_bindings b ON b.id = bl.binding_id
     WHERE b.profile_id = $1 AND b.tombstone = false",
  )
  .bind(profile_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_path_owners WHERE profile_id = $1")
    .bind(profile_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!((active_bindings, baselines, owners), (1, 1, 1));
  let second = run_cli(&["git-sync", "bootstrap", &profile_id.to_string()]);
  assert_eq!(second["report"]["noOp"], true);
  assert_eq!(second["report"]["writes"], serde_json::json!([]));
  assert_eq!(second["report"]["deletes"], serde_json::json!([]));

  git(work.path(), &["pull", "--ff-only"]);
  std::fs::write(work.path().join("content/unknown.bin"), [0_u8, 1, 2]).expect("write unknown binary");
  git(work.path(), &["add", "content/unknown.bin"]);
  git(work.path(), &["commit", "-m", "unknown managed binary"]);
  git(work.path(), &["push"]);
  let unknown = run_cli_failure(&["git-sync", "bootstrap", &profile_id.to_string()]);
  assert!(
    unknown.contains("unknown non-Markdown content") && unknown.contains("content/unknown.bin"),
    "{unknown}"
  );

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete bootstrap workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("delete bootstrap user");
}

struct SeededGitSync {
  user_id: Uuid,
  workspace_id: Uuid,
  profile_id: Uuid,
  run_id: Uuid,
  pre_push_run_id: Uuid,
  reconciliation_run_id: Uuid,
  verified_oid: String,
  reconciliation_oid: String,
  doc_conflict_id: Uuid,
  file_conflict_id: Uuid,
  partial_session_id: Uuid,
}

#[tokio::test]
async fn inv_cli_gitsync03_reconcile_reports_adoption_and_unresolved_identity() {
  let pool = setup_pool().await;
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let profile_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let sync_id = Uuid::new_v4();
  let (_bare, work, remote_url) = init_reconciliation_remote();
  let first_oid = write_reconciliation_remote(
    &work,
    workspace_id,
    &[(doc_id, sync_id, "Adopted", "content/adopted.md", "# Adopted\n")],
    "initial reconciliation fixture",
  );

  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'CLI reconcile', now())")
    .bind(user_id)
    .bind(format!("cli-reconcile-{user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("insert reconcile user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, 'CLI reconcile', false)")
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert reconcile workspace");
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Adopted')")
    .bind(doc_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("insert adoptable document");
  sqlx::query(
    "INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, auth_method, enabled)
     VALUES ($1, $2, $3, $4, 'main', 'content/', 'MyoxusToGit',
             'Manual', 'HttpsToken', false)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(user_id)
  .bind(&remote_url)
  .execute(&pool)
  .await
  .expect("insert disabled reconcile profile");
  let credential_id = Uuid::new_v4();
  let credential = myoxus_infrastructure::crypto::encrypt(TEST_CRYPTO_PRIVATE_KEY, br#"{"token":"local-fixture"}"#)
    .expect("encrypt fixture credential");
  sqlx::query(
    "INSERT INTO git_sync_credentials (id, profile_id, auth_method, label, encrypted_data)
     VALUES ($1, $2, 'HttpsToken', 'CLI fixture', $3)",
  )
  .bind(credential_id)
  .bind(profile_id)
  .bind(credential)
  .execute(&pool)
  .await
  .expect("insert reconcile credential");
  sqlx::query("UPDATE git_sync_profiles SET credential_id = $2 WHERE id = $1")
    .bind(profile_id)
    .bind(credential_id)
    .execute(&pool)
    .await
    .expect("bind reconcile credential");

  let dry_run = run_cli(&["git-sync", "reconcile", &profile_id.to_string()]);
  assert_eq!(dry_run["changesRequired"], true);
  assert_eq!(dry_run["bindingAdoptions"][0]["docId"], doc_id.to_string());
  assert_eq!(dry_run["bindingAdoptions"][0]["syncId"], sync_id.to_string());
  assert_eq!(dry_run["bindingAdoptions"][0]["repoPath"], "content/adopted.md");
  assert_eq!(dry_run["unresolvedRemoteDocuments"], serde_json::json!([]));

  let applied = run_cli(&[
    "git-sync",
    "reconcile",
    &profile_id.to_string(),
    "--apply",
    "--expected-remote-oid",
    &first_oid,
  ]);
  assert_eq!(applied["bindingAdoptions"][0]["docId"], doc_id.to_string());
  let no_op = run_cli(&["git-sync", "reconcile", &profile_id.to_string()]);
  assert_eq!(no_op["changesRequired"], false);
  assert_eq!(no_op["bindingAdoptions"], serde_json::json!([]));

  let unknown_doc_id = Uuid::new_v4();
  let unknown_sync_id = Uuid::new_v4();
  let moved_oid = write_reconciliation_remote(
    &work,
    workspace_id,
    &[
      (doc_id, sync_id, "Adopted", "content/adopted.md", "# Adopted\n"),
      (
        unknown_doc_id,
        unknown_sync_id,
        "Unknown",
        "content/unknown.md",
        "# Unknown\n",
      ),
    ],
    "add unresolved remote document",
  );
  let rejected = run_cli_failure_output(&[
    "git-sync",
    "reconcile",
    &profile_id.to_string(),
    "--apply",
    "--expected-remote-oid",
    &moved_oid,
  ]);
  let rejected_report: Value =
    serde_json::from_slice(&rejected.stdout).expect("rejected apply stdout must remain one JSON report");
  assert_eq!(rejected_report["changesRequired"], true);
  assert_eq!(
    rejected_report["unresolvedRemoteDocuments"][0],
    serde_json::json!({
      "docId": unknown_doc_id,
      "syncId": unknown_sync_id,
      "repoPath": "content/unknown.md",
      "reason": "unknown_document_id",
    })
  );
  assert!(
    String::from_utf8_lossy(&rejected.stderr).contains("unresolved remote document"),
    "stderr must give a concise non-sensitive rejection reason: {}",
    String::from_utf8_lossy(&rejected.stderr)
  );

  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(profile_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

async fn seed_git_sync_surface(pool: &PgPool, suffix: &str) -> SeededGitSync {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, $3, now())")
    .bind(user_id)
    .bind(format!("{suffix}-{user_id}@test.local"))
    .bind(format!("cli git sync {suffix}"))
    .execute(pool)
    .await
    .expect("insert user");

  let workspace_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding) \
     VALUES ($1, $2, $3, false, true, true, true, true)",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(format!("git-sync-cli-{workspace_id}"))
  .execute(pool)
  .await
  .expect("insert workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert accepted Git-Sync owner membership");

  let profile_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_profiles \
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction, trigger_mode, auth_method, enabled) \
     VALUES ($1, $2, $3, $4, 'main', 'content/', 'Bidirectional', 'Manual', 'HttpsToken', true)",
  )
  .bind(profile_id)
  .bind(workspace_id)
  .bind(user_id)
  .bind(format!("https://git.example.test/myoxus/{profile_id}.git"))
  .execute(pool)
  .await
  .expect("insert profile");

  let run_id = Uuid::new_v4();
  let verified_oid = "a".repeat(40);
  sqlx::query(
    "INSERT INTO git_sync_runs \
       (id, profile_id, direction, trigger_source, status, started_at, finished_at,
        commit_before, commit_after, observed_remote_oid, job_id,
        docs_created, docs_updated, docs_deleted, conflicts_found) \
     VALUES ($1, $2, 'Bidirectional', 'Manual', 'Completed',
             now() - interval '3 minutes', now() - interval '2 minutes',
             $3, $4, $4, 'completed-job', 1, 2, 3, 4)",
  )
  .bind(run_id)
  .bind(profile_id)
  .bind("0".repeat(40))
  .bind(&verified_oid)
  .execute(pool)
  .await
  .expect("insert run");

  let pre_push_run_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_runs \
       (id, profile_id, direction, trigger_source, status, started_at, finished_at,
        commit_before, job_id, error_message, error_class,
        docs_created, docs_updated, docs_deleted, conflicts_found) \
     VALUES ($1, $2, 'MyoxusToGit', 'Polling', 'Failed',
             now() - interval '2 minutes', now() - interval '1 minute',
             $3, 'pre-push-job', 'remote unavailable', 'GitNetwork',
             0, 0, 0, 0)",
  )
  .bind(pre_push_run_id)
  .bind(profile_id)
  .bind(&verified_oid)
  .execute(pool)
  .await
  .expect("insert pre-push failure");

  let reconciliation_run_id = Uuid::new_v4();
  let reconciliation_oid = "b".repeat(40);
  sqlx::query(
    "INSERT INTO git_sync_runs \
       (id, profile_id, direction, trigger_source, status, started_at, finished_at,
        commit_before, observed_remote_oid, reconciliation_required,
        reconciliation_reason, job_id, error_message, error_class,
        docs_created, docs_updated, docs_deleted, conflicts_found) \
     VALUES ($1, $2, 'GitToMyoxus', 'Webhook', 'Failed',
             now() - interval '1 minute', now(), $3, $4, true,
             'remote moved; database finalization rolled back',
             'reconciliation-job', 'reconciliation required', 'InternalError',
             5, 6, 7, 1)",
  )
  .bind(reconciliation_run_id)
  .bind(profile_id)
  .bind(&verified_oid)
  .bind(&reconciliation_oid)
  .execute(pool)
  .await
  .expect("insert reconciliation-required failure");

  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by) \
     VALUES ($1, $2, $3, 'viewer', false, $4, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("git sync cli doc {doc_id}"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert doc");

  let binding_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_bindings \
       (id, profile_id, workspace_id, doc_id, sync_id, repo_path, content_hash, tombstone) \
     VALUES ($1, $2, $3, $4, $5, 'content/doc.md', 'doc-hash', false)",
  )
  .bind(binding_id)
  .bind(profile_id)
  .bind(workspace_id)
  .bind(doc_id)
  .bind(Uuid::new_v4())
  .execute(pool)
  .await
  .expect("insert doc binding");

  let file_binding_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_file_bindings \
       (id, profile_id, workspace_id, blob_key, repo_path, content_hash, mime_type, file_size, tombstoned) \
     VALUES ($1, $2, $3, $4, 'content/assets/check.png', 'file-hash', 'image/png', 42, false)",
  )
  .bind(file_binding_id)
  .bind(profile_id)
  .bind(workspace_id)
  .bind(format!("git-sync/{profile_id}/content/assets/check.png"))
  .execute(pool)
  .await
  .expect("insert file binding");

  let doc_conflict_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_conflicts \
       (id, profile_id, binding_id, doc_id, repo_path, conflict_type, resolution) \
     VALUES ($1, $2, $3, $4, 'content/doc.md', 'BothModified', 'Open')",
  )
  .bind(doc_conflict_id)
  .bind(profile_id)
  .bind(binding_id)
  .bind(doc_id)
  .execute(pool)
  .await
  .expect("insert doc conflict");

  let file_conflict_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_file_conflicts \
       (id, profile_id, run_id, binding_id, blob_key, repo_path, conflict_type, resolution, git_hash, myoxus_hash, baseline_hash) \
     VALUES ($1, $2, $3, $4, $5, 'content/assets/check.png', 'BothModified', 'Open', 'git', 'myoxus', 'base')",
  )
  .bind(file_conflict_id)
  .bind(profile_id)
  .bind(run_id)
  .bind(file_binding_id)
  .bind(format!("git-sync/{profile_id}/content/assets/check.png"))
  .execute(pool)
  .await
  .expect("insert file conflict");

  let partial_session_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO git_sync_partial_sessions \
       (id, profile_id, direction, source_git_commit_oid, status, total_items, processed_items, failed_items, created_run_id, last_run_id) \
     VALUES ($1, $2, 'Bidirectional', 'abc123', 'Open', 5, 3, 1, $3, $3)",
  )
  .bind(partial_session_id)
  .bind(profile_id)
  .bind(run_id)
  .execute(pool)
  .await
  .expect("insert partial session");

  SeededGitSync {
    user_id,
    workspace_id,
    profile_id,
    run_id,
    pre_push_run_id,
    reconciliation_run_id,
    verified_oid,
    reconciliation_oid,
    doc_conflict_id,
    file_conflict_id,
    partial_session_id,
  }
}

async fn cleanup_seed(pool: &PgPool, seed: &SeededGitSync) {
  sqlx::query("DELETE FROM git_sync_profiles WHERE id = $1")
    .bind(seed.profile_id)
    .execute(pool)
    .await
    .expect("delete seeded Git-Sync profile");
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(seed.workspace_id)
    .execute(pool)
    .await
    .expect("delete seeded Git-Sync documents");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(seed.workspace_id)
    .execute(pool)
    .await
    .expect("delete seeded Git-Sync workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(seed.user_id)
    .execute(pool)
    .await
    .expect("delete seeded Git-Sync user");
}

async fn set_app_config(pool: &PgPool, key: &str, value: Value) -> Option<Value> {
  let previous = sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = $1")
    .bind(key)
    .fetch_optional(pool)
    .await
    .expect("read previous app config");
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at) \
     VALUES ($1, $2, now(), now()) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .bind(key)
  .bind(value)
  .execute(pool)
  .await
  .expect("upsert app config");
  previous
}

async fn restore_app_config(pool: &PgPool, key: &str, previous: Option<Value>) {
  if let Some(value) = previous {
    sqlx::query("UPDATE app_configs SET value = $2, updated_at = now() WHERE id = $1")
      .bind(key)
      .bind(value)
      .execute(pool)
      .await
      .ok();
  } else {
    sqlx::query("DELETE FROM app_configs WHERE id = $1")
      .bind(key)
      .execute(pool)
      .await
      .ok();
  }
}

#[tokio::test]
async fn inv_cli_gitsync01_status_and_conflicts_include_doc_and_file_surface() {
  let pool = setup_pool().await;
  let seed = seed_git_sync_surface(&pool, "inv-cli-gitsync01").await;

  let conflicts = run_cli(&["git-sync", "conflicts", &seed.profile_id.to_string()]);
  let conflicts = conflicts.as_array().expect("conflicts output is array");
  assert_eq!(
    conflicts.len(),
    2,
    "CLI must show doc and file conflicts: {conflicts:?}"
  );
  assert!(
    conflicts
      .iter()
      .any(|row| row["object_kind"] == "document" && row["id"] == seed.doc_conflict_id.to_string()),
    "document conflict missing: {conflicts:?}"
  );
  assert!(
    conflicts.iter().any(|row| row["object_kind"] == "file"
      && row["id"] == seed.file_conflict_id.to_string()
      && row["run_id"] == seed.run_id.to_string()
      && row["blob_key"].as_str().unwrap_or_default().starts_with("git-sync/")),
    "file conflict with blob/run identity missing: {conflicts:?}"
  );

  let status = run_cli(&["git-sync", "status", &seed.profile_id.to_string()]);
  let rows = status.as_array().expect("status output is an array");
  let row = rows
    .iter()
    .find(|row| row["id"] == seed.run_id.to_string())
    .expect("completed run is present");
  assert_eq!(row["id"], seed.run_id.to_string());
  assert_eq!(row["docs_created"], 1);
  assert_eq!(row["docs_updated"], 2);
  assert_eq!(row["docs_deleted"], 3);
  assert_eq!(row["conflicts_found"], 4);
  assert_eq!(row["open_doc_conflicts"], 1);
  assert_eq!(row["open_file_conflicts"], 1);
  assert_eq!(row["total_doc_bindings"], 1);
  assert_eq!(row["total_file_bindings"], 1);
  assert_eq!(row["partial_session_id"], seed.partial_session_id.to_string());
  assert_eq!(row["partial_status"], "Open");
  assert_eq!(row["partial_has_more"], true);
  assert_eq!(row["partial_total_items"], 5);
  assert_eq!(row["partial_processed_items"], 3);
  assert_eq!(row["partial_failed_items"], 1);

  cleanup_seed(&pool, &seed).await;
}

#[tokio::test]
async fn inv_cli_gitsync04_status_preserves_nullable_cross_system_run_truth() {
  let pool = setup_pool().await;
  let seed = seed_git_sync_surface(&pool, "inv-cli-gitsync04").await;

  let status = run_cli(&["git-sync", "status", &seed.profile_id.to_string(), "--limit", "10"]);
  let rows = status.as_array().expect("status output is an array");
  assert_eq!(rows.len(), 3, "all three deterministic run states must be visible");

  let completed = rows
    .iter()
    .find(|row| row["id"] == seed.run_id.to_string())
    .expect("completed run");
  assert_eq!(completed["trigger_source"], "Manual");
  assert_eq!(completed["commit_after"], seed.verified_oid);
  assert_eq!(completed["observed_remote_oid"], seed.verified_oid);
  assert_eq!(completed["reconciliation_required"], false);
  assert!(completed["reconciliation_reason"].is_null());
  assert!(completed["error_class"].is_null());

  let pre_push = rows
    .iter()
    .find(|row| row["id"] == seed.pre_push_run_id.to_string())
    .expect("pre-push failure");
  assert_eq!(pre_push["trigger_source"], "Polling");
  assert_eq!(pre_push["error_class"], "GitNetwork");
  assert!(pre_push["commit_after"].is_null());
  assert!(pre_push["observed_remote_oid"].is_null());
  assert!(pre_push["reconciliation_reason"].is_null());
  assert_eq!(pre_push["reconciliation_required"], false);

  let reconciliation = rows
    .iter()
    .find(|row| row["id"] == seed.reconciliation_run_id.to_string())
    .expect("reconciliation-required failure");
  assert_eq!(reconciliation["trigger_source"], "Webhook");
  assert!(reconciliation["commit_after"].is_null());
  assert_eq!(reconciliation["observed_remote_oid"], seed.reconciliation_oid);
  assert_eq!(reconciliation["reconciliation_required"], true);
  assert_eq!(
    reconciliation["reconciliation_reason"],
    "remote moved; database finalization rolled back"
  );
  assert_eq!(reconciliation["docs_created"], 5);
  assert_eq!(reconciliation["docs_updated"], 6);
  assert_eq!(reconciliation["docs_deleted"], 7);

  cleanup_seed(&pool, &seed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_cli_gitsync02_trigger_dedupes_pending_runs_and_respects_effective_policy() {
  let pool = setup_pool().await;
  let seed = seed_git_sync_surface(&pool, "inv-cli-gitsync02").await;
  sqlx::query("DELETE FROM git_sync_runs WHERE profile_id = $1")
    .bind(seed.profile_id)
    .execute(&pool)
    .await
    .expect("remove seed completed run");

  let previous_enabled = set_app_config(&pool, "git_sync.enabled", Value::Bool(true)).await;
  let previous_directions = set_app_config(
    &pool,
    "git_sync.allowed_directions",
    serde_json::json!(["bidirectional", "myoxus_to_git", "git_to_myoxus"]),
  )
  .await;

  let first = run_cli_with_dispatch_ack(&pool, seed.profile_id).await;
  let second = run_cli(&["git-sync", "trigger", &seed.profile_id.to_string(), "--timeout", "3"]);
  let first_row = first
    .as_array()
    .and_then(|rows| rows.first())
    .expect("first trigger row");
  let second_row = second
    .as_array()
    .and_then(|rows| rows.first())
    .expect("second trigger row");
  assert_eq!(
    first_row["run_id"], second_row["run_id"],
    "second trigger must reuse existing pending run"
  );
  assert_eq!(
    first_row["direction"], "Bidirectional",
    "omitted CLI direction must use the profile direction"
  );
  assert_eq!(
    first_row["job_id"], second_row["job_id"],
    "CLI success requires the same persisted dispatch acknowledgement"
  );
  assert!(
    second_row["note"]
      .as_str()
      .unwrap_or_default()
      .contains("Existing unfinished run reused"),
    "second trigger must explain dedupe: {second_row:?}"
  );
  let pending_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_runs WHERE profile_id = $1 AND status = 'Pending'")
      .bind(seed.profile_id)
      .fetch_one(&pool)
      .await
      .expect("count pending runs");
  assert_eq!(pending_count, 1, "CLI trigger must not create duplicate Pending runs");

  let mismatch = run_cli_failure(&[
    "git-sync",
    "trigger",
    &seed.profile_id.to_string(),
    "--direction",
    "MyoxusToGit",
  ]);
  assert!(
    mismatch.contains("must equal the configured profile direction"),
    "explicit direction widening must fail closed: {mismatch}"
  );
  let count_after_mismatch: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM git_sync_runs WHERE profile_id = $1")
    .bind(seed.profile_id)
    .fetch_one(&pool)
    .await
    .expect("count runs after rejected widening");
  assert_eq!(
    count_after_mismatch, 1,
    "rejected direction widening must not create a run artifact"
  );

  set_app_config(&pool, "git_sync.enabled", Value::Bool(false)).await;
  let stderr = run_cli_failure(&["git-sync", "trigger", &seed.profile_id.to_string()]);
  assert!(
    stderr.contains("Git Sync is disabled by effective administrator policy"),
    "disabled policy error missing: {stderr}"
  );

  restore_app_config(&pool, "git_sync.enabled", previous_enabled).await;
  restore_app_config(&pool, "git_sync.allowed_directions", previous_directions).await;
  cleanup_seed(&pool, &seed).await;
}

#[tokio::test]
async fn token_rotation_cli_uses_minimal_arguments_and_scrubbed_shared_states() {
  let pool = setup_pool().await;
  let seed = seed_git_sync_surface(&pool, "token-rotation").await;
  let token = "compiled-cli-rotation-secret";
  let encrypted = myoxus_infrastructure::crypto::encrypt(
    TEST_CRYPTO_PRIVATE_KEY,
    format!(r#"{{"token":"{token}","username":null}}"#).as_bytes(),
  )
  .expect("encrypt CLI rotation credential");
  let credential_id: Uuid = sqlx::query_scalar(
    "INSERT INTO git_sync_credentials
       (profile_id, auth_method, label, encrypted_data, expires_at)
     VALUES ($1, 'HttpsToken', 'rotation-cli', $2, now() + interval '7 days')
     RETURNING id",
  )
  .bind(seed.profile_id)
  .bind(encrypted)
  .fetch_one(&pool)
  .await
  .expect("insert CLI rotation credential");
  sqlx::query(
    "UPDATE git_sync_profiles
     SET repo_url = $2, credential_id = $3, updated_at = now()
     WHERE id = $1",
  )
  .bind(seed.profile_id)
  .bind(format!("https://127.0.0.1:1/acme/{}.git", seed.profile_id))
  .bind(credential_id)
  .execute(&pool)
  .await
  .expect("activate CLI rotation credential");

  let configured = run_cli(&[
    "git-sync",
    "token-rotation",
    "configure",
    &seed.profile_id.to_string(),
    "--provider",
    "GitLab",
    "--enabled",
    "true",
    "--renew-before-days",
    "30",
    "--requested-lifetime-days",
    "90",
  ]);
  let configured = configured
    .as_array()
    .and_then(|rows| rows.first())
    .expect("configured row");
  assert_eq!(configured["provider"], "GitLab");
  assert_eq!(configured["state"], "Configured");
  assert_eq!(configured["enabled"], true);

  let status = run_cli(&["git-sync", "token-rotation", "status", &seed.profile_id.to_string()]);
  let serialized = serde_json::to_string(&status).expect("serialize CLI rotation status");
  for forbidden in [token, "scope", "accessLevel", "branch", "remoteTokenId"] {
    assert!(
      !serialized.contains(forbidden),
      "CLI rotation status exposed {forbidden}"
    );
  }

  let failed = run_cli_failure_output(&["git-sync", "token-rotation", "run-now", &seed.profile_id.to_string()]);
  let failure_output = format!(
    "{}{}",
    String::from_utf8_lossy(&failed.stdout),
    String::from_utf8_lossy(&failed.stderr)
  );
  assert!(!failure_output.contains(token));
  let failed_status = run_cli(&["git-sync", "token-rotation", "status", &seed.profile_id.to_string()]);
  assert_eq!(failed_status[0]["state"], "Failed");

  cleanup_seed(&pool, &seed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_cli_gitsync05_cron_preview_status_and_manual_trigger_share_durable_state() {
  let pool = setup_pool().await;
  let seed = seed_git_sync_surface(&pool, "inv-cli-gitsync05").await;
  sqlx::query("DELETE FROM git_sync_runs WHERE profile_id = $1")
    .bind(seed.profile_id)
    .execute(&pool)
    .await
    .expect("remove seed runs");
  let next = chrono::DateTime::parse_from_rfc3339("2099-01-01T05:00:00Z")
    .unwrap()
    .with_timezone(&chrono::Utc);
  sqlx::query(
    "WITH profile AS (UPDATE git_sync_profiles
     SET trigger_mode = 'Cron',
         polling_interval_secs = NULL,
         cron_expression = '0 * * * *',
         cron_timezone = 'UTC',
          cron_misfire_policy = 'RunOnce'
      WHERE id=$1 RETURNING id,workspace_id,owner_id)
      INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,next_nominal,next_due_at,next_admission_at)
      SELECT id,workspace_id,owner_id,'UTC',jsonb_build_object('kind','git_cron','profile_id',id),
        jsonb_build_object('kind','local_date_time','value',to_char($2::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US')),$2,$2
      FROM profile",
  )
  .bind(seed.profile_id)
  .bind(next)
  .execute(&pool)
  .await
  .expect("configure Cron profile");
  let previous_enabled = set_app_config(&pool, "git_sync.enabled", Value::Bool(true)).await;
  let previous_directions = set_app_config(
    &pool,
    "git_sync.allowed_directions",
    serde_json::json!(["bidirectional", "myoxus_to_git", "git_to_myoxus"]),
  )
  .await;

  let preview = run_cli(&[
    "git-sync",
    "schedule-preview",
    "--cron",
    "0 * * * *",
    "--cron-timezone",
    "UTC",
    "--count",
    "3",
  ]);
  let preview = preview.as_array().expect("preview rows");
  assert_eq!(preview.len(), 3);
  assert!(
    preview
      .windows(2)
      .all(|pair| pair[0]["scheduled_at_utc"].as_str() < pair[1]["scheduled_at_utc"].as_str()),
    "compiled CLI preview must return increasing server schedule slots"
  );

  let status = run_cli(&["git-sync", "schedule", &seed.profile_id.to_string(), "--count", "3"]);
  let status = status.as_array().and_then(|rows| rows.first()).expect("schedule row");
  assert_eq!(status["cron_expression"], "0 * * * *");
  assert_eq!(status["cron_timezone"], "UTC");
  assert_eq!(status["misfire_policy"], "RunOnce");
  assert_eq!(status["next_scheduled_at"], next.to_rfc3339());
  assert!(
    status["preview_utc"]
      .as_str()
      .unwrap_or_default()
      .starts_with(&next.to_rfc3339()),
    "profile schedule must begin with its durable next UTC slot: {status:?}"
  );

  let triggered = run_cli_with_dispatch_ack(&pool, seed.profile_id).await;
  assert_eq!(triggered[0]["status"], "Pending");
  let (source, scheduled_for): (String, Option<chrono::DateTime<chrono::Utc>>) =
    sqlx::query_as("SELECT trigger_source, scheduled_for FROM git_sync_runs WHERE profile_id = $1")
      .bind(seed.profile_id)
      .fetch_one(&pool)
      .await
      .expect("manual Cron-profile run");
  assert_eq!(source, "Manual");
  assert!(scheduled_for.is_none());
  let next_after: chrono::DateTime<chrono::Utc> =
    sqlx::query_scalar("SELECT next_due_at FROM scheduling_schedules WHERE id=$1")
      .bind(seed.profile_id)
      .fetch_one(&pool)
      .await
      .expect("Cron cursor after manual CLI run");
  assert_eq!(next_after, next);

  restore_app_config(&pool, "git_sync.enabled", previous_enabled).await;
  restore_app_config(&pool, "git_sync.allowed_directions", previous_directions).await;
  cleanup_seed(&pool, &seed).await;
}
