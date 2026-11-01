//! Workspace-local document identity invariants.

use crate::helpers;

use myoxus_application::doc::{
  DocMetadataStore, DocSpaceKind, DocUpdateStore, DocUpdateWrite, DocWriteTarget, ValidatedExternalYjsUpdate,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::doc::SqlxDocStore;
use sqlx::Row;
use uuid::Uuid;
use yrs::{Doc, Text, Transact};

fn text_update(value: &str) -> Vec<u8> {
  let doc = Doc::new();
  let text = doc.get_or_insert_text("body");
  let mut txn = doc.transact_mut();
  text.insert(&mut txn, 0, value);
  txn.encode_update_v1()
}

async fn validated_update(payload: Vec<u8>) -> (Vec<u8>, ValidatedExternalYjsUpdate) {
  let permit = std::sync::Arc::new(tokio::sync::Semaphore::new(1))
    .acquire_owned()
    .await
    .expect("decoder permit");
  let (payload, decoded) = yjs::decode_update_v1_guarded(payload, permit)
    .await
    .expect("valid Yjs update");
  (payload, ValidatedExternalYjsUpdate::new(decoded, 1024 * 1024))
}

#[tokio::test]
async fn inv_doc_id_same_external_key_is_isolated_between_workspaces() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "docid-workspace-scope", false).await;
  let workspace_ids = [Uuid::new_v4(), Uuid::new_v4()];
  for (index, workspace_id) in workspace_ids.iter().enumerate() {
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
      .bind(workspace_id)
      .bind(user_id)
      .bind(format!("docid-workspace-{index}"))
      .execute(&pool)
      .await
      .expect("create workspace");
  }

  let store = SqlxDocStore::new(pool.clone());
  let document_key = DocumentKey::parse("same-client-document-key").unwrap();
  let mut internal_ids = Vec::new();
  for (index, workspace_id) in workspace_ids.iter().enumerate() {
    let (payload, validated_external_update) = validated_update(text_update(&format!("workspace {index}"))).await;
    let persisted = store
      .push_update(DocUpdateWrite {
        sync_operation_id: Some(Uuid::new_v4()),
        connection_context: None,
        workspace_id: *workspace_id,
        target: DocWriteTarget::External(document_key.clone()),
        validated_external_update: Some(validated_external_update),
        payload,
        space_kind: DocSpaceKind::Workspace,
        actor_user_id: None,
        client_format: None,
        client_capabilities: None,
        initial_provenance: None,
      })
      .await
      .expect("persist workspace-scoped document");
    internal_ids.push(persisted.doc_id);
  }

  assert_ne!(internal_ids[0], internal_ids[1]);
  for (workspace_id, expected_internal_id) in workspace_ids.iter().zip(internal_ids.iter()) {
    assert_eq!(
      store
        .resolve_external_doc_id(*workspace_id, DocSpaceKind::Workspace, document_key.as_str())
        .await
        .expect("resolve document key"),
      Some(*expected_internal_id)
    );
  }

  let (second_payload, validated_external_update) = validated_update(text_update("second write")).await;
  let second_write = store
    .push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id: workspace_ids[0],
      target: DocWriteTarget::External(document_key.clone()),
      validated_external_update: Some(validated_external_update),
      payload: second_payload,
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: None,
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
    })
    .await
    .expect("repeat write resolves existing document");
  assert_eq!(second_write.doc_id, internal_ids[0]);

  let rows =
    sqlx::query("SELECT workspace_id, id, external_id FROM docs WHERE workspace_id = ANY($1) ORDER BY workspace_id")
      .bind(workspace_ids)
      .fetch_all(&pool)
      .await
      .expect("load scoped document rows");
  assert_eq!(rows.len(), 2);
  assert!(
    rows
      .iter()
      .all(|row| row.get::<String, _>("external_id") == document_key.as_str())
  );

  let update_counts: Vec<(Uuid, i64)> = sqlx::query_as(
    "SELECT workspace_id, COUNT(*)::BIGINT FROM doc_updates WHERE doc_id = ANY($1) GROUP BY workspace_id ORDER BY workspace_id",
  )
  .bind(&internal_ids)
  .fetch_all(&pool)
  .await
  .expect("load isolated updates");
  assert_eq!(update_counts.iter().map(|(_, count)| *count).sum::<i64>(), 3);
  assert!(update_counts.iter().any(|(_, count)| *count == 2));
  assert!(update_counts.iter().any(|(_, count)| *count == 1));

  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(workspace_ids)
    .execute(&pool)
    .await
    .expect("delete workspaces");
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
}

#[tokio::test]
async fn inv_doc_id_uuid_shaped_external_key_never_falls_back_to_internal_uuid() {
  let pool = helpers::setup_pool().await;
  let user_id = helpers::create_user(&pool, "docid-uuid-shaped-external", false).await;
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind("UUID-shaped external identity")
    .execute(&pool)
    .await
    .expect("create workspace");

  let colliding_internal_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, $5, $5)",
  )
  .bind(colliding_internal_id)
  .bind("unrelated-route-key")
  .bind(workspace_id)
  .bind("Unrelated document")
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert the unrelated internal UUID collision row");

  let store = SqlxDocStore::new(pool.clone());
  let document_key = DocumentKey::parse(colliding_internal_id.to_string()).unwrap();
  let (payload, validated_external_update) = validated_update(text_update("first UUID-shaped write")).await;
  let first = store
    .push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id,
      target: DocWriteTarget::External(document_key.clone()),
      validated_external_update: Some(validated_external_update),
      payload,
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: Some(user_id),
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
    })
    .await
    .expect("UUID-shaped external key must materialize its own row");
  assert_ne!(first.doc_id, colliding_internal_id);

  let (payload, validated_external_update) = validated_update(text_update("repeated UUID-shaped write")).await;
  let repeated = store
    .push_update(DocUpdateWrite {
      sync_operation_id: Some(Uuid::new_v4()),
      connection_context: None,
      workspace_id,
      target: DocWriteTarget::External(document_key.clone()),
      validated_external_update: Some(validated_external_update),
      payload,
      space_kind: DocSpaceKind::Workspace,
      actor_user_id: Some(user_id),
      client_format: None,
      client_capabilities: None,
      initial_provenance: None,
    })
    .await
    .expect("repeated first-write resolution must retain the external-key row");
  assert_eq!(repeated.doc_id, first.doc_id);
  assert_eq!(
    store
      .resolve_external_doc_id(workspace_id, DocSpaceKind::Workspace, document_key.as_str())
      .await
      .expect("resolve UUID-shaped external key"),
    Some(first.doc_id)
  );

  let rows = sqlx::query(
    "SELECT id, external_id FROM docs
     WHERE workspace_id = $1 AND id = ANY($2)
     ORDER BY external_id",
  )
  .bind(workspace_id)
  .bind([colliding_internal_id, first.doc_id])
  .fetch_all(&pool)
  .await
  .expect("load both identity rows");
  assert_eq!(rows.len(), 2);
  assert!(rows.iter().any(|row| {
    row.get::<Uuid, _>("id") == colliding_internal_id && row.get::<String, _>("external_id") == "unrelated-route-key"
  }));
  assert!(rows.iter().any(|row| {
    row.get::<Uuid, _>("id") == first.doc_id && row.get::<String, _>("external_id") == document_key.as_str()
  }));
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(first.doc_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    2
  );
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(colliding_internal_id)
      .fetch_one(&pool)
      .await
      .unwrap(),
    0,
    "external resolution must never write to a textually colliding docs.id"
  );

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete workspace");
  helpers::cleanup_users(&pool, &[user_id]).await;
}
