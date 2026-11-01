// SPDX-License-Identifier: AGPL-3.0-or-later
//! P100-SRV-A — Workspace blob cleanup after deletion.
//!
//! Invariants:
//!   INV-BLC-01: After workspace deletion, the workspace row is gone from the DB.
//!   INV-BLC-02: After workspace deletion, blob rows for that workspace are gone (CASCADE).
//!   INV-BLC-03: workspace.cleanupBlobs job is enqueued when blobs exist (requires Redis).
//!   INV-BLC-04: Deletion succeeds even when no Redis queue is available (graceful).
//!   INV-BLC-A04: Trash retains blob metadata regardless of age; maintenance
//!                only considers records without a Workspace as orphans.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Insert a workspace row and return its ID.
async fn create_workspace(pool: &sqlx::PgPool, owner_id: Uuid) -> Uuid {
  let ws_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, public, created_at, updated_at) VALUES ($1, $2, false, now(), now())",
  )
  .bind(ws_id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert workspace");
  ws_id
}

/// Insert a blob row for the workspace and return its key.
async fn create_blob_row(pool: &sqlx::PgPool, workspace_id: Uuid, key: &str) {
  sqlx::query(
    "INSERT INTO blobs (workspace_id, key, size, mime, status, created_at, updated_at) VALUES ($1, $2, 42, 'application/octet-stream', 'completed', now(), now())"
  )
  .bind(workspace_id)
  .bind(key)
  .execute(pool)
  .await
  .expect("insert blob row");
}

/// Count blob rows for a workspace in the DB.
async fn count_blobs(pool: &sqlx::PgPool, workspace_id: Uuid) -> i64 {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blobs WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .expect("count blobs")
}

/// Check if workspace row exists.
async fn workspace_exists(pool: &sqlx::PgPool, workspace_id: Uuid) -> bool {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .expect("count workspaces")
    > 0
}

// ---------------------------------------------------------------------------
// INV-BLC-01 + INV-BLC-02: Workspace and blobs rows removed after admin delete
// ---------------------------------------------------------------------------

/// INV-BLC-01: Admin deleteWorkspace removes the workspace row.
/// INV-BLC-02: CASCADE removes all associated blob rows.
#[tokio::test]
async fn inv_blc01_blc02_workspace_and_blobs_removed_after_admin_delete() {
  let pool = helpers::setup_pool().await;
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;

  // Arrange: admin user + workspace with blobs
  let (_, admin_session) = helpers::seed_admin_db(&pool).await;
  let owner_id = helpers::create_user(&pool, "owner", false).await;
  let ws_id = create_workspace(&pool, owner_id).await;

  let blob_key_1 = format!("test-blob-{}.bin", Uuid::new_v4().simple());
  let blob_key_2 = format!("test-blob-{}.bin", Uuid::new_v4().simple());
  create_blob_row(&pool, ws_id, &blob_key_1).await;
  create_blob_row(&pool, ws_id, &blob_key_2).await;

  assert!(
    workspace_exists(&pool, ws_id).await,
    "INV-BLC-01: workspace must exist before delete"
  );
  assert_eq!(
    count_blobs(&pool, ws_id).await,
    2,
    "INV-BLC-02: blob rows must exist before delete"
  );

  // Act: delete workspace via admin GraphQL
  let _ = auth_store; // keep auth_store alive for session
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($id: ID!) { admin { deleteWorkspace(id: $id) } }",
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;

  assert!(
    resp.get("errors").is_none(),
    "INV-BLC-01: admin deleteWorkspace must not return errors; got: {resp}"
  );
  assert_eq!(
    resp["data"]["admin"]["deleteWorkspace"].as_bool(),
    Some(true),
    "INV-BLC-01: deleteWorkspace must return true"
  );

  // Assert: INV-BLC-01 — workspace row is gone
  assert!(
    !workspace_exists(&pool, ws_id).await,
    "INV-BLC-01: workspace row must be absent after deletion"
  );

  // Assert: INV-BLC-02 — blob rows are gone via CASCADE
  assert_eq!(
    count_blobs(&pool, ws_id).await,
    0,
    "INV-BLC-02: blob rows must be absent after workspace CASCADE delete"
  );
}

// ---------------------------------------------------------------------------
// INV-BLC-04: Deletion succeeds without Redis queue (graceful degradation)
// ---------------------------------------------------------------------------

/// INV-BLC-04: deleteWorkspace succeeds even when no Redis queue is configured.
/// The blob collection + enqueue path must be resilient to missing queue.
/// (The test setup does not inject a Redis queue into the test app state.)
#[tokio::test]
async fn inv_blc04_workspace_delete_succeeds_without_redis_queue() {
  let pool = helpers::setup_pool().await;
  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;

  let (_, admin_session) = helpers::seed_admin_db(&pool).await;
  let owner_id = helpers::create_user(&pool, "owner2", false).await;
  let ws_id = create_workspace(&pool, owner_id).await;

  // Insert a blob so the code path that would enqueue a job is triggered
  let blob_key = format!("graceful-{}.bin", Uuid::new_v4().simple());
  create_blob_row(&pool, ws_id, &blob_key).await;

  let _ = auth_store;
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($id: ID!) { admin { deleteWorkspace(id: $id) } }",
      "variables": { "id": ws_id.to_string() }
    }),
  )
  .await;

  // The deletion must succeed even though no queue is available — no panic, no error
  assert!(
    resp.get("errors").is_none(),
    "INV-BLC-04: deleteWorkspace must succeed without Redis queue; got: {resp}"
  );
  assert_eq!(
    resp["data"]["admin"]["deleteWorkspace"].as_bool(),
    Some(true),
    "INV-BLC-04: deleteWorkspace must return true without Redis queue"
  );

  // Workspace and blobs both gone
  assert!(
    !workspace_exists(&pool, ws_id).await,
    "workspace row must be absent after deletion"
  );
  assert_eq!(
    count_blobs(&pool, ws_id).await,
    0,
    "blob rows must be absent after workspace deletion"
  );
}

// ---------------------------------------------------------------------------
// Retention regression: call the real maintenance adapter, rather than mirror
// its SQL. A present Workspace is protected even after its trash timestamp ages.
#[tokio::test]
async fn inv_a04_orphan_cleanup_preserves_restorable_workspace_blobs() {
  use futures_util::FutureExt;
  let pool = helpers::setup_pool().await;
  let store = std::sync::Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (owner, _) = helpers::seed_user(&pool, &store, "orphan-retention").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let blob_store = myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone());
  let journey = std::panic::AssertUnwindSafe(async {
    create_blob_row(&pool, workspace, &format!("retained-{workspace}")).await;
    sqlx::query("UPDATE workspaces SET deleted_at=now()-interval '25 hours' WHERE id=$1")
      .bind(workspace)
      .execute(&pool)
      .await
      .unwrap();
    assert!(
      blob_store.workspace_record_exists(workspace).await.unwrap(),
      "delayed purge jobs must skip retained rows"
    );
    let cleaned = blob_store
      .clean_orphaned_workspace_blobs(24, 500, 10_000)
      .await
      .unwrap();
    assert!(
      !cleaned.workspaces.iter().any(|(id, _)| *id == workspace),
      "trash is not an orphan"
    );
    assert_eq!(
      count_blobs(&pool, workspace).await,
      1,
      "maintenance cannot destroy recoverable metadata"
    );
    let service = myoxus_application::workspace::WorkspaceService::new(std::sync::Arc::new(
      myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ),
    ));
    assert_eq!(service.undelete_workspace(workspace).await.unwrap().id, workspace);
    assert_eq!(
      count_blobs(&pool, workspace).await,
      1,
      "restore retains original blob row"
    );
    sqlx::query("DELETE FROM workspaces WHERE id=$1")
      .bind(workspace)
      .execute(&pool)
      .await
      .unwrap();
    assert!(
      !blob_store.workspace_record_exists(workspace).await.unwrap(),
      "permanent purge authorizes delayed file cleanup"
    );
    assert_eq!(
      count_blobs(&pool, workspace).await,
      0,
      "permanent purge still cascades metadata"
    );
  })
  .catch_unwind()
  .await;
  helpers::cleanup_users(&pool, &[owner]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=$1")
      .bind(owner)
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_user_trash_retains_blobs_and_only_permanent_admin_purge_enqueues_cleanup() {
  use futures_util::FutureExt;
  let namespace = format!("workspace-retention-{}", Uuid::new_v4().simple());
  let (app, pool, store, queue) = helpers::setup_app_with_worker_queue(namespace.clone()).await;
  let (owner, session) = helpers::seed_user(&pool, &store, "trash-retention").await;
  let (admin, admin_session) = helpers::seed_admin(&pool, &store).await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let journey = std::panic::AssertUnwindSafe(async {
    create_blob_row(&pool, workspace, &format!("trash-retained-{workspace}")).await;
    queue
      .enqueue(
        "workspace",
        "retention-sentinel",
        json!({}),
        myoxus_worker::JobOptions::default(),
      )
      .await
      .unwrap();
    assert_eq!(
      queue.list_jobs("workspace", "waiting", 0, 20).await.unwrap().1,
      1,
      "live isolated Redis queue"
    );
    let deleted = helpers::gql(
      &app,
      session,
      json!({"query":"mutation($id:String!){deleteWorkspace(id:$id)}","variables":{"id":workspace}}),
    )
    .await;
    assert!(deleted.get("errors").is_none(), "{deleted}");
    assert_eq!(deleted["data"]["deleteWorkspace"], true);
    assert!(workspace_exists(&pool, workspace).await);
    assert_eq!(count_blobs(&pool, workspace).await, 1);
    assert_eq!(
      queue.list_jobs("workspace", "waiting", 0, 20).await.unwrap().1,
      1,
      "trash must not enqueue irreversible file deletion"
    );
    let purged = helpers::gql(
      &app,
      admin_session,
      json!({"query":"mutation($id:ID!){admin{deleteWorkspace(id:$id)}}","variables":{"id":workspace}}),
    )
    .await;
    assert!(purged.get("errors").is_none(), "{purged}");
    assert_eq!(purged["data"]["admin"]["deleteWorkspace"], true);
    assert!(!workspace_exists(&pool, workspace).await);
    assert_eq!(count_blobs(&pool, workspace).await, 0);
    let (jobs, total) = queue.list_jobs("workspace", "waiting", 0, 20).await.unwrap();
    assert_eq!(total, 2, "positive control proves the API uses this real queue");
    assert!(jobs.iter().any(|job| job["name"] == "workspace.cleanupBlobs"));
  })
  .catch_unwind()
  .await;
  queue.empty_queue("workspace").await.expect("remove owned waiting jobs");
  let url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".into());
  let mut connection = redis::Client::open(url)
    .unwrap()
    .get_multiplexed_async_connection()
    .await
    .unwrap();
  let mut cursor = 0u64;
  let mut keys = Vec::<String>::new();
  loop {
    let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
      .arg(cursor)
      .arg("MATCH")
      .arg(format!("{namespace}:*"))
      .arg("COUNT")
      .arg(100)
      .query_async(&mut connection)
      .await
      .unwrap();
    keys.extend(found);
    cursor = next;
    if cursor == 0 {
      break;
    }
  }
  if !keys.is_empty() {
    let _: usize = redis::cmd("DEL")
      .arg(&keys)
      .query_async(&mut connection)
      .await
      .expect("remove only this fixture namespace");
  }
  helpers::cleanup_users(&pool, &[owner, admin]).await;
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users WHERE id=ANY($1)")
      .bind(&[owner, admin][..])
      .fetch_one(&pool)
      .await
      .unwrap(),
    0
  );
  if let Err(panic) = journey {
    std::panic::resume_unwind(panic);
  }
}
