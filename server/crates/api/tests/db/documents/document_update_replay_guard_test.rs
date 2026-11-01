// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable replay and CRDT-no-op invariants for external document pushes.

use std::sync::Arc;

use myoxus_application::doc::{
  DocService, DocSpaceKind, DocSyncClientKind, DocSyncConnectionContext, DocUpdatePersistenceOutcome,
  InitialDocumentProvenance,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_infrastructure::doc::SqlxDocStore;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

fn doc_service(pool: &sqlx::PgPool) -> DocService {
  DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
}

fn text_update(value: &str) -> Vec<u8> {
  let doc = Doc::new();
  let text = doc.get_or_insert_text("body");
  let mut txn = doc.transact_mut();
  text.insert(&mut txn, 0, value);
  txn.encode_update_v1()
}

async fn push_external(
  service: &DocService,
  workspace_id: Uuid,
  user_id: Uuid,
  document_key: &DocumentKey,
  payload: Vec<u8>,
) -> myoxus_application::doc::DocUpdatePersistenceResult {
  service
    .push_external_update_with_context(
      Uuid::new_v4(),
      None,
      workspace_id,
      document_key.clone(),
      payload,
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("replay-guard-integration".to_string()),
      None,
      None,
    )
    .await
    .expect("external Yjs update")
}

#[tokio::test]
async fn inv_doc_sync_replay_1000_identical_pushes_create_one_durable_update() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "doc-replay-1000", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let service = doc_service(&pool);
  let document_key = DocumentKey::parse(format!("replay-{}", Uuid::new_v4())).expect("document key");
  let payload = text_update("exactly once");

  let first = push_external(&service, workspace_id, user_id, &document_key, payload.clone()).await;
  assert_eq!(first.outcome, DocUpdatePersistenceOutcome::Persisted);
  for _ in 1..1_000 {
    let replay = push_external(&service, workspace_id, user_id, &document_key, payload.clone()).await;
    assert_eq!(replay.doc_id, first.doc_id);
    assert_eq!(replay.outcome, DocUpdatePersistenceOutcome::ExactReplay);
  }

  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(first.doc_id)
    .fetch_one(&pool)
    .await
    .expect("count durable updates");
  let digest_count: i64 = sqlx::query_scalar("SELECT COUNT(payload_sha256) FROM doc_updates WHERE doc_id = $1")
    .bind(first.doc_id)
    .fetch_one(&pool)
    .await
    .expect("count server digests");
  assert_eq!(update_count, 1);
  assert_eq!(digest_count, 1);

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_doc_sync_replay_semantically_known_encoding_is_crdt_noop() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "doc-semantic-replay", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let service = doc_service(&pool);
  let document_key = DocumentKey::parse(format!("semantic-{}", Uuid::new_v4())).expect("document key");

  let source = Doc::new();
  let text = source.get_or_insert_text("body");
  let insert = {
    let mut txn = source.transact_mut();
    text.insert(&mut txn, 0, "temporary");
    txn.encode_update_v1()
  };
  let delete = {
    let mut txn = source.transact_mut();
    text.remove_range(&mut txn, 0, 9);
    txn.encode_update_v1()
  };
  let known_state_encoding = source.transact().encode_state_as_update_v1(&StateVector::default());
  assert_ne!(known_state_encoding, insert);
  assert_ne!(known_state_encoding, delete);

  let inserted = push_external(&service, workspace_id, user_id, &document_key, insert).await;
  assert_eq!(inserted.outcome, DocUpdatePersistenceOutcome::Persisted);
  let deleted = push_external(&service, workspace_id, user_id, &document_key, delete).await;
  assert_eq!(deleted.outcome, DocUpdatePersistenceOutcome::Persisted);
  let equivalent = push_external(&service, workspace_id, user_id, &document_key, known_state_encoding).await;
  assert_eq!(equivalent.outcome, DocUpdatePersistenceOutcome::CrdtNoop);

  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(inserted.doc_id)
    .fetch_one(&pool)
    .await
    .expect("count semantic updates");
  assert_eq!(update_count, 2);

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_doc_sync_replay_concurrent_client_edits_both_survive() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "doc-concurrent-edits", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let service = doc_service(&pool);
  let document_key = DocumentKey::parse(format!("concurrent-{}", Uuid::new_v4())).expect("document key");
  let base = text_update("base");
  let first = push_external(&service, workspace_id, user_id, &document_key, base.clone()).await;
  assert_eq!(first.outcome, DocUpdatePersistenceOutcome::Persisted);
  sqlx::query("UPDATE docs SET sync_state_vector_v1 = NULL WHERE id = $1")
    .bind(first.doc_id)
    .execute(&pool)
    .await
    .expect("simulate one pre-P05 document");

  let branch_update = |marker: &str| {
    let branch = Doc::new();
    let branch_text = branch.get_or_insert_text("body");
    branch
      .transact_mut()
      .apply_update(Update::decode_v1(&base).expect("decode base"))
      .expect("apply base");
    let mut txn = branch.transact_mut();
    branch_text.insert(&mut txn, 0, marker);
    txn.encode_update_v1()
  };
  let edit_a = branch_update("A");
  let edit_b = branch_update("B");
  let (result_a, result_b) = tokio::join!(
    push_external(&service, workspace_id, user_id, &document_key, edit_a),
    push_external(&service, workspace_id, user_id, &document_key, edit_b),
  );
  assert_eq!(result_a.outcome, DocUpdatePersistenceOutcome::Persisted);
  assert_eq!(result_b.outcome, DocUpdatePersistenceOutcome::Persisted);

  let durable = service
    .load_full_doc(workspace_id, first.doc_id)
    .await
    .expect("load merged concurrent state");
  let merged = Doc::new();
  let merged_text = merged.get_or_insert_text("body");
  merged
    .transact_mut()
    .apply_update(Update::decode_v1(&durable).expect("decode durable state"))
    .expect("apply durable state");
  let visible = merged_text.get_string(&merged.transact());
  assert!(visible.contains('A'), "first concurrent edit missing: {visible}");
  assert!(visible.contains('B'), "second concurrent edit missing: {visible}");
  assert!(visible.contains("base"), "base state missing: {visible}");

  let update_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1")
    .bind(first.doc_id)
    .fetch_one(&pool)
    .await
    .expect("count concurrent updates");
  assert_eq!(update_count, 3);
  let rebuilt_state_vector: Option<Vec<u8>> = sqlx::query_scalar("SELECT sync_state_vector_v1 FROM docs WHERE id = $1")
    .bind(first.doc_id)
    .fetch_one(&pool)
    .await
    .expect("load reconstructed state vector");
  assert!(
    rebuilt_state_vector.is_some(),
    "the first write against a legacy NULL vector must reconstruct it lazily"
  );

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_doc_sync_web_context_does_not_create_browser_identity_audit() {
  let pool = crate::helpers::setup_pool().await;
  let user_id = crate::helpers::create_user(&pool, "doc-handshake-identity", false).await;
  let workspace_id = crate::helpers::create_workspace(&pool, user_id).await;
  let service = doc_service(&pool);
  let document_key = DocumentKey::parse(format!("identity-{}", Uuid::new_v4())).expect("document key");
  let payload_claim = Uuid::new_v4().to_string();
  let provenance: InitialDocumentProvenance = serde_json::from_value(serde_json::json!({
    "clientInstanceId": payload_claim,
    "provenanceMode": "offline_sync"
  }))
  .expect("client provenance");
  let persisted = service
    .push_external_update_with_context(
      Uuid::new_v4(),
      Some(DocSyncConnectionContext {
        client_kind: DocSyncClientKind::Web,
      }),
      workspace_id,
      document_key,
      text_update("handshake-owned identity"),
      0,
      DocSpaceKind::Workspace,
      Some(user_id),
      Some("myoxus-native".to_string()),
      Some("offline-origin-v1".to_string()),
      Some(provenance),
    )
    .await
    .expect("persist first sync");

  let (audit_id, raw, normalized): (Option<String>, serde_json::Value, serde_json::Value) = sqlx::query_as(
    "SELECT client_instance_id, raw_provenance, normalized_provenance \
     FROM document_initial_sync_audit WHERE doc_id = $1",
  )
  .bind(persisted.doc_id)
  .fetch_one(&pool)
  .await
  .expect("load first-sync identity audit");
  assert_eq!(audit_id, None);
  assert_eq!(raw["clientInstanceId"], payload_claim);
  assert_eq!(normalized["connectionClientKind"], "web");
  assert!(normalized.get("connectionClientInstanceHash").is_none());
  assert_eq!(normalized["clientInstanceId"], serde_json::Value::Null);
  assert_eq!(normalized["provenanceMode"], "server_observed_first_sync");

  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}
