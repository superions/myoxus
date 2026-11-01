// SPDX-License-Identifier: AGPL-3.0-or-later
//! Isolated PostgreSQL coverage for explicit Organizer order-key repair.

use crate::support;

use std::sync::Arc;

use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_application::organizer::{OrganizerError, OrganizerService};
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, Out, ReadTxn, StateVector, Transact};

async fn setup_pool() -> PgPool {
  let pool = PgPoolOptions::new()
    .max_connections(3)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("materialize isolated test schema");
  pool
}

fn run_cli(args: &[&str]) -> Value {
  let output = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("--json")
    .args(args)
    .output()
    .expect("run myoxus-cli");
  assert!(
    output.status.success(),
    "CLI failed\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("CLI stdout must be JSON")
}

fn legacy_organizer_update() -> Vec<u8> {
  let doc = Doc::new();
  let index = doc.get_or_insert_map("myoxus$mcp_folder_index");
  let rows = ["0000", "0100", "0150", "0175", "0200", "0300"];
  {
    let mut txn = doc.transact_mut();
    index.insert(&mut txn, "$$DELETED", true);
    for position in 0..rows.len() {
      let id = format!("legacy-{position}");
      index.insert(&mut txn, id.clone(), true);
    }
  }
  for (position, key) in rows.into_iter().enumerate() {
    let id = format!("legacy-{position}");
    {
      let row = doc.get_or_insert_map(id.as_str());
      let mut txn = doc.transact_mut();
      row.insert(&mut txn, "id", id.clone());
      row.insert(&mut txn, "data", format!("Legacy {position}"));
      row.insert(&mut txn, "type", "folder");
      row.insert(&mut txn, "index", key);
      if position == 0 {
        row.insert(&mut txn, "fixtureMetadata", "preserve-me");
      }
    }
  }
  doc.transact().encode_state_as_update_v1(&StateVector::default())
}

fn unrelated_collaborative_update() -> Vec<u8> {
  let doc = Doc::new();
  let metadata = doc.get_or_insert_map("fixture$collaboration");
  let mut txn = doc.transact_mut();
  metadata.insert(&mut txn, "revision", Uuid::new_v4().to_string());
  txn.encode_update_v1()
}

#[tokio::test]
async fn inv_cli_organizer_reindex_is_dry_run_by_default_revision_safe_and_single_append() {
  let pool = setup_pool().await;
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, $3, now())")
    .bind(user_id)
    .bind(format!("organizer-reindex-{user_id}@test.local"))
    .bind("Organizer reindex fixture")
    .execute(&pool)
    .await
    .expect("insert fixture user");
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)
     VALUES ($1, $2, $3, false, true, true, true, true)",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(format!("Organizer reindex {workspace_id}"))
  .execute(&pool)
  .await
  .expect("insert fixture workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Owner', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert fixture membership");

  let doc = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let document_key = DocumentKey::parse(format!("db${workspace_id}$folders")).expect("Organizer document key");
  let doc_id = doc
    .push_external_update_raw(
      workspace_id,
      document_key.clone(),
      legacy_organizer_update(),
      DocSpaceKind::Workspace,
    )
    .await
    .expect("seed legacy Organizer fixture");

  let count_updates = || async {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count Organizer updates")
  };
  let seeded_count = count_updates().await;
  let workspace = workspace_id.to_string();
  let dry_run = run_cli(&["organizer", "reindex-order", "--workspace-id", &workspace]);
  assert_eq!(dry_run["status"], "dry_run");
  assert_eq!(dry_run["affectedParentGroups"], 1);
  assert_eq!(dry_run["rowCount"], 6);
  assert_eq!(count_updates().await, seeded_count, "default dry-run must not append");

  let organizer = OrganizerService::new(doc.clone());
  let stale_plan = organizer.plan_reindex(workspace_id).await.expect("plan stale fixture");
  doc
    .push_external_update_raw(
      workspace_id,
      document_key,
      unrelated_collaborative_update(),
      DocSpaceKind::Workspace,
    )
    .await
    .expect("append concurrent fixture update");
  let concurrent_count = count_updates().await;
  assert!(matches!(
    organizer.apply_reindex(&stale_plan).await,
    Err(OrganizerError::StaleRevision { .. })
  ));
  assert_eq!(
    count_updates().await,
    concurrent_count,
    "stale apply must write nothing"
  );

  let applied = run_cli(&["organizer", "reindex-order", "--workspace-id", &workspace, "--apply"]);
  assert_eq!(applied["status"], "applied");
  assert_eq!(applied["rowCount"], 6);
  assert_eq!(
    count_updates().await,
    concurrent_count + 1,
    "apply must append exactly once"
  );

  let repeated = run_cli(&["organizer", "reindex-order", "--workspace-id", &workspace]);
  assert_eq!(repeated["status"], "dry_run");
  assert_eq!(repeated["affectedParentGroups"], 0);
  assert_eq!(repeated["rowCount"], 0);
  assert_eq!(count_updates().await, concurrent_count + 1);

  let repeated_apply = run_cli(&["organizer", "reindex-order", "--workspace-id", &workspace, "--apply"]);
  assert_eq!(repeated_apply["status"], "unchanged");
  assert_eq!(repeated_apply["affectedParentGroups"], 0);
  assert_eq!(repeated_apply["rowCount"], 0);
  assert_eq!(
    count_updates().await,
    concurrent_count + 1,
    "repeated apply must not append"
  );

  let repaired = doc
    .load_full_doc(workspace_id, doc_id)
    .await
    .expect("load repaired Organizer");
  let materialized = Doc::new();
  materialized
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&repaired).expect("decode repaired Organizer"))
    .expect("materialize repaired Organizer");
  let first = materialized.get_or_insert_map("legacy-0");
  assert!(matches!(
    first.get(&materialized.transact(), "fixtureMetadata"),
    Some(Out::Any(Any::String(value))) if value.as_ref() == "preserve-me"
  ));

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete fixture workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("delete fixture user");
}
