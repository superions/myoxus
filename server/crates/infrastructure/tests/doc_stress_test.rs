//! Stress tests for concurrent Yjs document update handling.
use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::doc::traits::DocMetadataStore;
use myoxus_application::workspace::WorkspaceStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::task;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Text, Transact, Update};

async fn setup_db() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");
  pool
}

fn create_update_payload(task_id: i32) -> Vec<u8> {
  let ydoc = Doc::new();
  let text = ydoc.get_or_insert_text("content");
  let mut tx = ydoc.transact_mut();
  text.insert(&mut tx, 0, &format!("Task {} ", task_id));
  tx.encode_update_v1()
}

#[tokio::test]
async fn test_concurrent_doc_updates() {
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
  let doc_service = Arc::new(DocService::new(doc_store.clone()));

  let user = auth_store
    .fulfill_user("stress_test@example.com", Some("Stress Tester"), None)
    .await
    .unwrap();
  let ws = workspace_store
    .create_workspace(user.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .unwrap();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Stress Doc')")
    .bind(doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();

  // Spawn 20 concurrent tasks pushing updates
  let mut handles = vec![];
  for i in 0..20 {
    let ds = doc_service.clone();
    let ws_id = ws.id;
    handles.push(task::spawn(async move {
      let update = create_update_payload(i);
      ds.push_update(
        ws_id,
        doc_id,
        update,
        i as i64,
        myoxus_application::doc::DocSpaceKind::Workspace,
      )
      .await
    }));
  }

  for h in handles {
    h.await.unwrap().unwrap();
  }

  // Verify all 20 updates are merged correctly
  let full_binary = doc_service.load_full_doc(ws.id, doc_id).await.unwrap();
  let loaded_doc = Doc::new();
  let loaded_text = loaded_doc.get_or_insert_text("content");
  {
    let mut tx = loaded_doc.transact_mut();
    tx.apply_update(Update::decode_v1(&full_binary).unwrap())
      .expect("apply yjs update");
  }

  let result_text = loaded_text.get_string(&loaded_doc.transact());
  for i in 0..20 {
    assert!(result_text.contains(&format!("Task {} ", i)));
  }
}

#[tokio::test]
async fn test_soft_delete_isolation() {
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

  let user = auth_store
    .fulfill_user("delete_test@example.com", Some("Delete Tester"), None)
    .await
    .unwrap();
  let ws = workspace_store
    .create_workspace(user.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .unwrap();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'To be deleted')")
    .bind(doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();

  // 1. Push an update
  let update = create_update_payload(999);
  doc_service
    .push_update(
      ws.id,
      doc_id,
      update,
      1,
      myoxus_application::doc::DocSpaceKind::Workspace,
    )
    .await
    .unwrap();

  // 2. Soft delete
  doc_service.soft_delete_doc(doc_id).await.unwrap();

  // 3. Try to load metadata
  let meta = doc_store.get_doc_metadata(doc_id).await.unwrap();
  assert!(meta.is_none(), "Metadata should not be returned for deleted doc");
}

#[tokio::test]
async fn test_large_update_chain_merging() {
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

  let user = auth_store
    .fulfill_user("chain_test@example.com", Some("Chain Tester"), None)
    .await
    .unwrap();
  let ws = workspace_store
    .create_workspace(user.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .unwrap();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'Chain Doc')")
    .bind(doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();

  // Push 100 small updates
  for i in 0..100 {
    let update = create_update_payload(i);
    doc_service
      .push_update(
        ws.id,
        doc_id,
        update,
        i as i64,
        myoxus_application::doc::DocSpaceKind::Workspace,
      )
      .await
      .unwrap();
  }

  let full = doc_service.load_full_doc(ws.id, doc_id).await.unwrap();
  let loaded_doc = Doc::new();
  let loaded_text = loaded_doc.get_or_insert_text("content"); // Note: create_update_payload uses "content"
  {
    let mut tx = loaded_doc.transact_mut();
    tx.apply_update(Update::decode_v1(&full).unwrap())
      .expect("apply yjs update");
  }
  // Each update adds "Task i ", so 100 updates should have content
  assert!(loaded_text.get_string(&loaded_doc.transact()).len() > 100);
}
