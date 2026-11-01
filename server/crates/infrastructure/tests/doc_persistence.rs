//! Integration tests for Yjs document persistence (push updates, apply, merge).
use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::doc::traits::DocSnapshotStore;
use myoxus_application::workspace::WorkspaceStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Map, Text, Transact};

async fn setup_db() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database");

  // Materialize the canonical schema, including document snapshots.
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");

  pool
}

#[tokio::test]
async fn test_doc_update_and_snapshot_persistence() {
  let pool = setup_db().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  ));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let doc_service = DocService::new(doc_store.clone());

  // 1. Setup User and Workspace
  let user = auth_store
    .fulfill_user("doc_test@example.com", Some("Doc Tester"), None)
    .await
    .unwrap();
  let ws = workspace_store
    .create_workspace(user.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .unwrap();

  // 2. Create a Doc entry
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, $3)")
    .bind(doc_id)
    .bind(ws.id)
    .bind("Test Doc")
    .execute(&pool)
    .await
    .unwrap();

  // 3. Push Yjs Updates
  let ydoc = Doc::new();
  let text = ydoc.get_or_insert_text("content");

  // Update 1
  let update1 = {
    let mut tx = ydoc.transact_mut();
    text.insert(&mut tx, 0, "Part 1");
    tx.encode_update_v1()
  };
  doc_service
    .push_update(
      ws.id,
      doc_id,
      update1,
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();

  // Update 2
  let update2 = {
    let mut tx = ydoc.transact_mut();
    text.insert(&mut tx, 6, " Part 2");
    tx.encode_update_v1()
  };
  doc_service
    .push_update(
      ws.id,
      doc_id,
      update2,
      2,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();

  // 4. Load full doc and verify content
  let full_binary = doc_service.load_full_doc(ws.id, doc_id).await.unwrap();

  let loaded_doc = Doc::new();
  let loaded_text = loaded_doc.get_or_insert_text("content");
  {
    let mut tx = loaded_doc.transact_mut();
    tx.apply_update(yrs::Update::decode_v1(&full_binary).unwrap())
      .expect("apply yjs update");
  }

  assert_eq!(loaded_text.get_string(&loaded_doc.transact()), "Part 1 Part 2");

  // 5. Save Snapshot
  doc_store.save_snapshot(doc_id, ws.id, full_binary, 2).await.unwrap();

  // 6. Load again (should now use snapshot)
  let after_snapshot_binary = doc_service.load_full_doc(ws.id, doc_id).await.unwrap();

  let final_doc = Doc::new();
  let final_text = final_doc.get_or_insert_text("content");
  {
    let mut tx = final_doc.transact_mut();
    tx.apply_update(yrs::Update::decode_v1(&after_snapshot_binary).unwrap())
      .expect("apply yjs update");
  }
  assert_eq!(final_text.get_string(&final_doc.transact()), "Part 1 Part 2");

  // 7. Test create_page (Root-Doc Sync)
  let new_page = doc_service
    .create_page(ws.id, user.id, Some("My Page".to_string()))
    .await
    .unwrap();
  assert_eq!(new_page.title, "My Page");

  // Load root doc and check if page is registered
  let root_binary = doc_service.load_full_doc(ws.id, ws.id).await.unwrap();
  let root_ydoc = Doc::new();
  let pages_map = root_ydoc.get_or_insert_map("pages");
  {
    let mut tx = root_ydoc.transact_mut();
    tx.apply_update(yrs::Update::decode_v1(&root_binary).unwrap())
      .expect("apply yjs update");
  }

  let registered_title = pages_map.get(&root_ydoc.transact(), &new_page.id.to_string()).unwrap();
  // Yjs Map.get returns an Out (Value), we need to check if it's the string
  assert!(registered_title.to_string(&root_ydoc.transact()).contains("My Page"));

  // 8. EDGE CASE: Corrupt Yjs Data
  let corrupt_data = vec![0x01, 0x02, 0x03, 0xFF, 0xFE];
  let merge_res = yjs::merge_updates(vec![corrupt_data]);
  assert!(merge_res.is_err(), "Merging corrupt data should fail");

  // 9. STRESS TEST: Large Payload (1MB)
  let large_string = "A".repeat(1024 * 1024);
  let large_ydoc = Doc::new();
  let large_text = large_ydoc.get_or_insert_text("large");
  let large_update = {
    let mut tx = large_ydoc.transact_mut();
    large_text.insert(&mut tx, 0, &large_string);
    tx.encode_update_v1()
  };

  let large_doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Large Doc')")
    .bind(large_doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();

  doc_service
    .push_update(
      ws.id,
      large_doc_id,
      large_update,
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();
  let loaded_large = doc_service.load_full_doc(ws.id, large_doc_id).await.unwrap();
  assert!(loaded_large.len() > 1024 * 1024);
}
