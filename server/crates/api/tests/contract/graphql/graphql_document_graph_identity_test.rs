// SPDX-License-Identifier: AGPL-3.0-or-later

//! Document Graph identity projection and reindex invariants.

use std::collections::HashMap;
use std::sync::Arc;

use myoxus_application::doc::DocService;
use myoxus_application::document_graph::{DocumentGraphLimits, DocumentGraphService};
use myoxus_application::document_metadata::DocumentMetadataService;
use myoxus_application::permission::PermissionService;
use myoxus_domain::document_graph::{DocumentGraphDirection, DocumentGraphTargetState};
use myoxus_domain::repositories::DocumentGraphRepository;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_graph::PgDocumentGraphRepository;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
use yrs::types::Attrs;
use yrs::updates::encoder::Encode;
use yrs::{Any, Array, Doc, Map, Text, Transact};

use crate::helpers;

async fn insert_doc(pool: &PgPool, workspace_id: Uuid, actor_id: Uuid, doc_id: Uuid, external_id: &str, deleted: bool) {
  sqlx::query(
    r#"INSERT INTO docs
         (id, external_id, workspace_id, title, default_role, is_workspace_root,
          created_by, updated_by, deleted_at)
       VALUES ($1, $2, $3, $2, 'viewer', FALSE, $4, $4,
               CASE WHEN $5 THEN now() ELSE NULL END)"#,
  )
  .bind(doc_id)
  .bind(external_id)
  .bind(workspace_id)
  .bind(actor_id)
  .bind(deleted)
  .execute(pool)
  .await
  .expect("insert Document Graph identity fixture document");
}

fn linked_page_attrs(external_id: &str) -> Attrs {
  let mut reference = HashMap::new();
  reference.insert("type".to_string(), Any::String("LinkedPage".into()));
  reference.insert("pageId".to_string(), Any::String(external_id.to_string().into()));
  reference.insert("mode".to_string(), Any::String("page".into()));
  Attrs::from([("reference".into(), Any::Map(Arc::new(reference)))])
}

fn linked_document_update(external_ids: &[String]) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();

  let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
  page.insert(&mut txn, "sys:flavour", "myoxus:page");
  let page_children = page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  page_children.push_back(&mut txn, "note");

  let note = blocks.insert(&mut txn, "note", yrs::MapPrelim::default());
  note.insert(&mut txn, "sys:flavour", "myoxus:note");
  let note_children = note.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());

  for (index, external_id) in external_ids.iter().enumerate() {
    let block_id = format!("reference-{index:02}");
    note_children.push_back(&mut txn, block_id.as_str());
    let paragraph = blocks.insert(&mut txn, block_id, yrs::MapPrelim::default());
    paragraph.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    paragraph.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    let text = paragraph.insert(&mut txn, "prop:text", yrs::TextPrelim::new("target"));
    text.format(&mut txn, 0, 6, linked_page_attrs(external_id));
  }

  txn.encode_update_v1()
}

#[tokio::test]
async fn document_graph_reindex_resolves_workspace_external_keys_and_projects_them_to_graphql() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (actor_id, session_id) = helpers::seed_user(&pool, &auth_store, "doc-graph-identity").await;
  let workspace_id = helpers::create_workspace(&pool, actor_id).await;
  let other_workspace_id = helpers::create_workspace(&pool, actor_id).await;

  let source_id = Uuid::new_v4();
  let nano_target_id = Uuid::new_v4();
  let uuid_default_target_id = Uuid::new_v4();
  let deleted_target_id = Uuid::new_v4();
  let collision_shape = Uuid::new_v4();
  let collision_target_id = Uuid::new_v4();
  let cross_workspace_target_id = Uuid::new_v4();
  let source_external_id = "DocGraphSourceNano9t";
  let nano_target_external_id = "DocGraphTargetNano4x";
  let deleted_target_external_id = "DocGraphDeletedNano7q";
  let cross_workspace_external_id = "DocGraphCrossWorkspace5m";
  let missing_external_id = "DocGraphMissingNano2k";
  let malformed_external_id = "  ";
  let collision_external_id = collision_shape.to_string();

  insert_doc(&pool, workspace_id, actor_id, source_id, source_external_id, false).await;
  insert_doc(
    &pool,
    workspace_id,
    actor_id,
    nano_target_id,
    nano_target_external_id,
    false,
  )
  .await;
  insert_doc(
    &pool,
    workspace_id,
    actor_id,
    uuid_default_target_id,
    &uuid_default_target_id.to_string(),
    false,
  )
  .await;
  insert_doc(
    &pool,
    workspace_id,
    actor_id,
    deleted_target_id,
    deleted_target_external_id,
    true,
  )
  .await;
  insert_doc(
    &pool,
    workspace_id,
    actor_id,
    collision_shape,
    "DocGraphCollisionOccupant3p",
    false,
  )
  .await;
  insert_doc(
    &pool,
    workspace_id,
    actor_id,
    collision_target_id,
    &collision_external_id,
    false,
  )
  .await;
  insert_doc(
    &pool,
    other_workspace_id,
    actor_id,
    cross_workspace_target_id,
    cross_workspace_external_id,
    false,
  )
  .await;

  let raw_targets = vec![
    nano_target_external_id.to_string(),
    uuid_default_target_id.to_string(),
    deleted_target_external_id.to_string(),
    cross_workspace_external_id.to_string(),
    missing_external_id.to_string(),
    malformed_external_id.to_string(),
    collision_external_id.clone(),
  ];
  let update = linked_document_update(&raw_targets);
  sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 1)")
    .bind(source_id)
    .bind(workspace_id)
    .bind(update)
    .execute(&pool)
    .await
    .expect("persist real Yjs Document Graph fixture");

  let graph_repo = Arc::new(PgDocumentGraphRepository::new(pool.clone()));
  let graph_service = DocumentGraphService::new(
    graph_repo.clone(),
    Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))),
    Arc::new(PermissionService::new(auth_store.clone())),
    Arc::new(DocumentMetadataService::new(Arc::new(
      PgDocumentMetadataRepository::new(pool.clone()),
    ))),
    None,
    None,
    None,
    DocumentGraphLimits::default(),
  );
  let outcome = graph_service
    .reindex_document_now(workspace_id, source_id)
    .await
    .expect("reindex real Yjs Document Graph fixture");
  let occurrences = graph_repo
    .list_doc_occurrences(
      workspace_id,
      source_id,
      DocumentGraphDirection::Outgoing,
      myoxus_domain::repositories::PageRequest { limit: 20, offset: 0 },
    )
    .await
    .expect("read reindexed Document Graph occurrences");

  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query DocumentGraphIdentity($workspaceId: String!, $source: ID!) {
        workspace(id: $workspaceId) {
          documentGraph(input: { focusDocId: $source, direction: Outgoing, first: 20, includeOccurrences: true }) {
            nodes { docId rawDocId deleted redacted }
            edges {
              sourceDocId targetDocId rawTargetDocId targetState
              occurrences { sourceDocId targetDocId rawTargetDocId targetState }
            }
          }
        }
      }"#,
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "source": source_external_id,
      }
    }),
  )
  .await;

  helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace_id]).await;
  helpers::cleanup_users(&pool, &[actor_id]).await;

  assert_eq!(outcome.reindexed_count, 1);
  let by_raw = occurrences
    .into_iter()
    .map(|occurrence| (occurrence.raw_target_doc_id.clone(), occurrence))
    .collect::<HashMap<_, _>>();
  assert_eq!(
    by_raw[nano_target_external_id].target_doc_id,
    Some(nano_target_id),
    "NanoID target must resolve to its different internal UUID"
  );
  assert_eq!(
    by_raw[nano_target_external_id].target_state,
    DocumentGraphTargetState::Available
  );
  assert_eq!(
    by_raw[&uuid_default_target_id.to_string()].target_doc_id,
    Some(uuid_default_target_id),
    "UUID-default document remains supported through the same external-key lookup"
  );
  assert_eq!(
    by_raw[deleted_target_external_id].target_doc_id,
    Some(deleted_target_id)
  );
  assert_eq!(
    by_raw[deleted_target_external_id].target_state,
    DocumentGraphTargetState::Deleted
  );
  assert_eq!(by_raw[cross_workspace_external_id].target_doc_id, None);
  assert_eq!(
    by_raw[cross_workspace_external_id].target_state,
    DocumentGraphTargetState::Missing
  );
  assert_eq!(by_raw[missing_external_id].target_doc_id, None);
  assert_eq!(
    by_raw[missing_external_id].target_state,
    DocumentGraphTargetState::Missing
  );
  assert_eq!(by_raw[malformed_external_id].target_doc_id, None);
  assert_eq!(
    by_raw[malformed_external_id].target_state,
    DocumentGraphTargetState::Unresolved
  );
  assert_eq!(
    by_raw[&collision_external_id].target_doc_id,
    Some(collision_target_id),
    "UUID-shaped external key must not bind to the row whose internal UUID has that shape"
  );

  assert!(
    response.get("errors").is_none(),
    "Document Graph GraphQL read failed: {response}"
  );
  let serialized = response.to_string();
  for internal_only_id in [source_id, nano_target_id, deleted_target_id, collision_target_id] {
    assert!(
      !serialized.contains(&internal_only_id.to_string()),
      "GraphQL response leaked internal document UUID {internal_only_id}: {response}"
    );
  }
  let edges = response["data"]["workspace"]["documentGraph"]["edges"]
    .as_array()
    .expect("Document Graph edges array");
  let nano_edge = edges
    .iter()
    .find(|edge| edge["rawTargetDocId"] == nano_target_external_id)
    .expect("NanoID edge in GraphQL response");
  assert_eq!(nano_edge["sourceDocId"], source_external_id);
  assert_eq!(nano_edge["targetDocId"], nano_target_external_id);
  assert_eq!(nano_edge["occurrences"][0]["sourceDocId"], source_external_id);
  assert_eq!(nano_edge["occurrences"][0]["targetDocId"], nano_target_external_id);
}
