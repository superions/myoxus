//! Integration tests for document history snapshots (create, list, restore).
use myoxus_application::auth::AuthStore;
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Text, Transact, Update};

async fn setup_db() -> PgPool {
  let database_url =
    std::env::var("TEST_DATABASE_URL").expect("doc history tests require the isolated TEST_DATABASE_URL");
  let pool = PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");
  pool
}

fn create_text_update(doc: &Doc, content: &str) -> Vec<u8> {
  let text = doc.get_or_insert_text("content");
  let mut tx = doc.transact_mut();
  text.insert(&mut tx, 0, content);
  tx.encode_update_v1()
}

fn read_text(bytes: &[u8]) -> String {
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(bytes).unwrap())
    .unwrap();
  doc.get_or_insert_text("content").get_string(&doc.transact())
}

#[tokio::test]
async fn test_doc_history_and_rollback() {
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
    .fulfill_user(
      &format!("history-{}@example.com", Uuid::new_v4()),
      Some("History Tester"),
      None,
    )
    .await
    .unwrap();
  let ws = workspace_store
    .create_workspace(user.id, myoxus_application::workspace::WorkspaceName::default_name())
    .await
    .unwrap();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title) VALUES ($1, $2, 'History Doc')")
    .bind(doc_id)
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();

  // 1. Version 1: "V1"
  let ydoc1 = Doc::new();
  let up1 = create_text_update(&ydoc1, "V1");
  doc_service
    .push_update(ws.id, doc_id, up1, 1, myoxus_application::doc::DocSpaceKind::Workspace)
    .await
    .unwrap();
  let (dirty_revision, first_pending_at): (i64, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
    "SELECT dirty_revision, first_pending_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws.id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("accepted content write records automatic-capture intent");
  assert_eq!(dirty_revision, 1);
  assert!(
    first_pending_at <= chrono::Utc::now(),
    "the accepted write, not a later polling pass, owns the interval anchor"
  );
  let h1_id = doc_service.capture_history_snapshot(doc_id).await.unwrap();
  let acknowledged: (i64, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
    "SELECT last_captured_revision, due_at FROM document_edit_capture_state WHERE workspace_id=$1 AND doc_id=$2",
  )
  .bind(ws.id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("current manual capture acknowledges pending automatic work");
  assert_eq!(acknowledged, (1, None));

  // 2. Version 2: "V2" (V1 + V2)
  let up2 = create_text_update(&ydoc1, "V2");
  doc_service
    .push_update(ws.id, doc_id, up2, 2, myoxus_application::doc::DocSpaceKind::Workspace)
    .await
    .unwrap();
  let _h2_id = doc_service.capture_history_snapshot(doc_id).await.unwrap();

  // 3. Current state is "V2V1"
  let current_binary = doc_service.load_full_doc(ws.id, doc_id).await.unwrap();
  let temp_doc = Doc::new();
  {
    let mut tx = temp_doc.transact_mut();
    tx.apply_update(Update::decode_v1(&current_binary).unwrap())
      .expect("apply yjs update");
  }
  assert!(
    temp_doc
      .get_or_insert_text("content")
      .get_string(&temp_doc.transact())
      .contains("V1")
  );
  assert!(
    temp_doc
      .get_or_insert_text("content")
      .get_string(&temp_doc.transact())
      .contains("V2")
  );

  // 4. List History
  let history = doc_service.list_history(ws.id, doc_id, 0, 10).await.unwrap();
  assert!(history.len() >= 2);

  // 5. Rollback to V1
  doc_service.rollback_to_history(doc_id, h1_id).await.unwrap();

  assert_eq!(
    read_text(&doc_service.load_full_doc(ws.id, doc_id).await.unwrap()),
    "V1"
  );
  let recovery = doc_service
    .list_history(ws.id, doc_id, 0, 10)
    .await
    .unwrap()
    .into_iter()
    .find(|entry| entry.id != h1_id && entry.id != _h2_id)
    .expect("restore retains the previous content as an unnamed snapshot");
  assert_eq!(
    read_text(&doc_service.history_entry(recovery.id).await.unwrap().unwrap().snapshot),
    "V2V1"
  );
  let restored_revision = doc_service.history.revision(ws.id, doc_id).await.unwrap();
  let request = |expected_sequence| myoxus_application::doc::history::HistoryRestoreRequest {
    workspace_id: ws.id,
    doc_id,
    history_id: recovery.id,
    expected_sequence,
    actor: myoxus_domain::audit::AuditActor::system(),
    named: None,
  };
  assert!(
    doc_service
      .history
      .restore(request(Some(restored_revision - 1)))
      .await
      .is_err()
  );
  assert_eq!(
    doc_service.history.revision(ws.id, doc_id).await.unwrap(),
    restored_revision
  );
  assert_eq!(doc_service.list_history(ws.id, doc_id, 0, 10).await.unwrap().len(), 3);
  assert_eq!(
    read_text(&doc_service.load_full_doc(ws.id, doc_id).await.unwrap()),
    "V1"
  );

  doc_service
    .history
    .restore(request(Some(restored_revision)))
    .await
    .unwrap();
  assert_eq!(
    read_text(&doc_service.load_full_doc(ws.id, doc_id).await.unwrap()),
    "V2V1"
  );
  // A lost success response must not permit a second commit with the old revision.
  assert!(
    doc_service
      .history
      .restore(request(Some(restored_revision)))
      .await
      .is_err()
  );
  assert_eq!(doc_service.list_history(ws.id, doc_id, 0, 10).await.unwrap().len(), 4);
  assert_eq!(
    doc_service.history.revision(ws.id, doc_id).await.unwrap(),
    restored_revision + 1
  );
  let updates: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_updates WHERE doc_id=$1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(updates, 4, "restore appends deltas; it never resets existing updates");
  sqlx::query("DELETE FROM outbox_events WHERE aggregate_id=$1")
    .bind(doc_id.to_string())
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM admin_audit_log WHERE target_id=$1")
    .bind(doc_id.to_string())
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws.id)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user.id)
    .execute(&pool)
    .await
    .unwrap();
}
