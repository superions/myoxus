// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Arc;
use std::time::Duration;

use myoxus_application::auth::AuthStore;
use myoxus_application::doc::{DocLoadCancellation, DocLoadStore};
use myoxus_application::workspace::WorkspaceStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{GetString, ReadTxn, StateVector, Text, Transact};

async fn setup_pool() -> sqlx::PgPool {
  let database_url =
    std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL must target the isolated repository test database");
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url)
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("apply repository migrations");
  pool
}

/// Compaction replaces a snapshot and deletes its covered update tail in one
/// transaction. This test forces the load between those operations and proves
/// that its repeatable-read view cannot combine an old snapshot with a newly
/// deleted tail.
#[tokio::test]
async fn snapshot_and_tail_share_one_repeatable_read_view_during_compaction() {
  let pool = setup_pool().await;
  let auth = SqlxAuthStore::from_pool(pool.clone());
  let workspaces = SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let user = auth
    .fulfill_user(
      &format!("sync-stream-{}@example.test", Uuid::new_v4()),
      Some("Synthetic sync stream"),
      None,
    )
    .await
    .expect("create synthetic user");
  let workspace = workspaces
    .create_workspace(
      user.id,
      myoxus_application::workspace::WorkspaceName::parse("Synthetic sync stream").unwrap(),
    )
    .await
    .expect("create synthetic workspace");
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Synthetic stream')")
    .bind(doc_id)
    .bind(workspace.id)
    .execute(&pool)
    .await
    .expect("create synthetic document");

  let source = yrs::Doc::new();
  let source_text = source.get_or_insert_text("content");
  let snapshot = {
    let mut txn = source.transact_mut();
    source_text.insert(&mut txn, 0, "base");
    txn.encode_state_as_update_v1(&StateVector::default())
  };
  let snapshot_vector = source.transact().state_vector();
  let tail = {
    let mut txn = source.transact_mut();
    source_text.insert(&mut txn, 4, " tail");
    txn.encode_diff_v1(&snapshot_vector)
  };
  let compacted_snapshot = source.transact().encode_state_as_update_v1(&StateVector::default());

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 0, now())",
  )
  .bind(doc_id)
  .bind(workspace.id)
  .bind(&snapshot)
  .execute(&pool)
  .await
  .expect("insert pre-compaction snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(doc_id)
  .bind(workspace.id)
  .bind(&tail)
  .execute(&pool)
  .await
  .expect("insert pre-compaction tail");

  let mut compaction = pool.begin().await.expect("begin synthetic compaction");
  sqlx::query("LOCK TABLE doc_updates IN ACCESS EXCLUSIVE MODE")
    .execute(&mut *compaction)
    .await
    .expect("hold the tail read until the load view exists");

  let store = Arc::new(SqlxDocStore::new(pool.clone()));
  let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
  let stream = {
    let store = store.clone();
    let workspace_id = workspace.id;
    tokio::spawn(async move {
      store
        .stream_doc_state(
          Uuid::new_v4(),
          workspace_id,
          doc_id,
          sender,
          DocLoadCancellation::default(),
        )
        .await
    })
  };
  let streamed_snapshot = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
    .await
    .expect("snapshot must stream before the locked tail query")
    .expect("snapshot row must be present");
  assert_eq!(streamed_snapshot, snapshot);

  sqlx::query(
    "UPDATE doc_snapshots SET payload = $3, last_sequence = 1, updated_at = now()
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace.id)
  .bind(doc_id)
  .bind(&compacted_snapshot)
  .execute(&mut *compaction)
  .await
  .expect("replace compacted snapshot");
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 AND sequence <= 1")
    .bind(workspace.id)
    .bind(doc_id)
    .execute(&mut *compaction)
    .await
    .expect("delete compacted tail");
  compaction.commit().await.expect("commit synthetic compaction");

  let streamed_tail = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
    .await
    .expect("stream must resume when compaction releases the tail table")
    .expect("the established read view must retain the old tail");
  assert_eq!(streamed_tail, tail);
  assert!(
    receiver.recv().await.is_none(),
    "stream contains exactly snapshot and tail"
  );
  let meta = stream.await.expect("stream task joins").expect("stream succeeds");
  assert_eq!(meta.stats.update_count, 2);

  let reconstructed = yrs::Doc::new();
  let reconstructed_text = reconstructed.get_or_insert_text("content");
  {
    let mut txn = reconstructed.transact_mut();
    txn
      .apply_update(yrs::Update::decode_v1(&streamed_snapshot).expect("decode snapshot"))
      .expect("apply snapshot");
    txn
      .apply_update(yrs::Update::decode_v1(&streamed_tail).expect("decode tail"))
      .expect("apply tail");
  }
  assert_eq!(reconstructed_text.get_string(&reconstructed.transact()), "base tail");

  let mut cleanup = pool.begin().await.expect("begin synthetic cleanup");
  for statement in [
    "DELETE FROM doc_updates WHERE workspace_id = $1",
    "DELETE FROM doc_snapshots WHERE workspace_id = $1",
    "DELETE FROM docs WHERE workspace_id = $1",
    "DELETE FROM workspace_memberships WHERE workspace_id = $1",
    "DELETE FROM workspaces WHERE id = $1",
  ] {
    sqlx::query(statement)
      .bind(workspace.id)
      .execute(&mut *cleanup)
      .await
      .expect("clean synthetic workspace state");
  }
  sqlx::query("DELETE FROM sessions WHERE user_id = $1")
    .bind(user.id)
    .execute(&mut *cleanup)
    .await
    .expect("clean synthetic sessions");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user.id)
    .execute(&mut *cleanup)
    .await
    .expect("clean synthetic user");
  cleanup.commit().await.expect("commit synthetic cleanup");
}
