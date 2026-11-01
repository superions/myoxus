//! GraphQL permanent document-delete regression gates.
//!
//! These tests assert the user-visible contract behind the trash UI: the new
//! GraphQL mutations must return structured results, remove the document row and
//! its denormalized references, and update the workspace root CRDT so stale page
//! entries cannot keep appearing in clients.

use crate::helpers;

// Permanent-delete propagation is tested with the current client contract;
// historical client rejection belongs to the WebSocket version tests.
const CURRENT_SYNC_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_application::doc::{DocService, DocSpaceKind};
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{Duration, sleep, timeout};
use tower::ServiceExt;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, ReadTxn, Transact};

async fn eio_handshake(app: &axum::Router, cookie: &str) -> String {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/socket.io/?EIO=4&transport=polling")
        .header("cookie", cookie)
        .body(Body::empty())
        .expect("build EIO handshake request"),
    )
    .await
    .expect("EIO handshake request");
  assert_eq!(response.status().as_u16(), 200, "EIO handshake must succeed");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect EIO body")
    .to_bytes();
  let text = String::from_utf8_lossy(&body);
  let json_start = text.find('{').expect("EIO open packet must contain JSON");
  let json_end = text.rfind('}').expect("EIO open packet must contain closing JSON") + 1;
  let json: Value = serde_json::from_str(&text[json_start..json_end]).expect("valid EIO open JSON");
  json["sid"].as_str().expect("EIO sid").to_string()
}

async fn sio_post(app: &axum::Router, sid: &str, cookie: &str, body: String) {
  let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
  app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri(&uri)
        .header("content-type", "text/plain;charset=UTF-8")
        .header("cookie", cookie)
        .body(Body::from(body))
        .expect("build SIO POST request"),
    )
    .await
    .expect("SIO POST request");
}

async fn sio_poll_for(app: &axum::Router, sid: &str, cookie: &str, needles: &[&str]) -> String {
  for _ in 0..20 {
    let uri = format!("/socket.io/?EIO=4&transport=polling&sid={sid}");
    let response = timeout(
      Duration::from_secs(2),
      app.clone().oneshot(
        Request::builder()
          .method("GET")
          .uri(&uri)
          .header("cookie", cookie)
          .body(Body::empty())
          .expect("build SIO GET request"),
      ),
    )
    .await
    .expect("SIO GET long-poll must return within the bounded test window")
    .expect("SIO GET request");
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect SIO body")
      .to_bytes();
    let text = String::from_utf8_lossy(&body).to_string();
    if needles.iter().any(|needle| text.contains(needle)) {
      return text;
    }
    if text == "2" || text.contains(":2") || text.starts_with("1:2") {
      sio_post(app, sid, cookie, "3".to_string()).await;
    }
    sleep(Duration::from_millis(25)).await;
  }
  String::new()
}

async fn sio_connect_and_join(app: &axum::Router, cookie: &str, workspace_id: Uuid) -> String {
  let sid = eio_handshake(app, cookie).await;
  sio_post(app, &sid, cookie, "40".to_string()).await;
  let connected = sio_poll_for(app, &sid, cookie, &["40"]).await;
  assert!(
    connected.contains("40"),
    "Socket.IO namespace connect must ACK, got: {connected}"
  );
  let join_payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "clientVersion": CURRENT_SYNC_CLIENT_VERSION,
  });
  sio_post(app, &sid, cookie, format!(r#"421["space:join",{}]"#, join_payload)).await;
  let joined = sio_poll_for(app, &sid, cookie, &["431"]).await;
  assert!(joined.contains("success"), "space:join must ACK success, got: {joined}");
  sid
}

fn build_root_doc_update(pages: &[(&str, bool)]) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  let mut txn = doc.transact_mut();
  meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
  let pages_arr = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(arr)) => arr,
    _ => panic!("could not create root meta.pages"),
  };

  for (page_id, is_trashed) in pages {
    let page = pages_arr.push_back(
      &mut txn,
      yrs::MapPrelim::from([("id".to_string(), Any::String((*page_id).into()))]),
    );
    if *is_trashed {
      page.insert(&mut txn, "trash", Any::Bool(true));
    }
  }

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

async fn push_root_meta(pool: &sqlx::PgPool, workspace_id: Uuid, pages: &[(&str, bool)]) {
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  service
    .push_update(
      workspace_id,
      workspace_id,
      build_root_doc_update(pages),
      1,
      DocSpaceKind::Workspace,
    )
    .await
    .expect("push root meta update");
}

fn root_page_ids_from_payloads(payloads: Vec<Vec<u8>>) -> Vec<String> {
  let doc = Doc::new();
  {
    let mut txn = doc.transact_mut();
    for payload in payloads {
      let update = yrs::Update::decode_v1(&payload).expect("decode root update");
      txn.apply_update(update).expect("apply yjs update");
    }
  }

  let meta = doc.get_or_insert_map("meta");
  let txn = doc.transact();
  let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") else {
    return Vec::new();
  };

  pages
    .iter(&txn)
    .filter_map(|value| match value {
      yrs::Out::YMap(map) => match map.get(&txn, "id") {
        Some(yrs::Out::Any(Any::String(id))) => Some(id.to_string()),
        _ => None,
      },
      _ => None,
    })
    .collect()
}

async fn root_page_ids(pool: &sqlx::PgPool, workspace_id: Uuid) -> Vec<String> {
  let payloads: Vec<Vec<u8>> =
    sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 ORDER BY sequence")
      .bind(workspace_id)
      .fetch_all(pool)
      .await
      .expect("load root doc updates");
  root_page_ids_from_payloads(payloads)
}

async fn loaded_root_page_ids(pool: &sqlx::PgPool, workspace_id: Uuid) -> Vec<String> {
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let full_doc = service
    .load_full_doc(workspace_id, workspace_id)
    .await
    .expect("load full root doc");
  root_page_ids_from_payloads(vec![full_doc])
}

async fn insert_original_doc(pool: &sqlx::PgPool, workspace_id: Uuid, actor_id: Uuid, external_id: &str) -> Uuid {
  let doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by, deleted_at)
     VALUES ($1, $2, $3, $4, 'viewer', FALSE, $5, $5, now())",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("page-{external_id}"))
  .bind(external_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert original doc");
  doc_id
}

async fn insert_delete_dependents(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  doc_id: Uuid,
  external_id: &str,
  actor_id: Uuid,
) {
  sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 1)")
    .bind(doc_id)
    .bind(workspace_id)
    .bind(vec![1_u8, 2_u8])
    .execute(pool)
    .await
    .expect("insert doc update");

  sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 1)")
    .bind(doc_id)
    .bind(workspace_id)
    .bind(vec![3_u8, 4_u8])
    .execute(pool)
    .await
    .expect("insert doc snapshot");

  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(vec![5_u8, 6_u8])
      .fetch_one(pool)
      .await
      .expect("insert doc history");

  sqlx::query(
    "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by)
     VALUES ($1, $2, $3, 'delete-regression', $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(history_id)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("insert document version");

  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Reader')")
    .bind(actor_id)
    .bind(doc_id)
    .execute(pool)
    .await
    .expect("insert doc permission");

  sqlx::query("INSERT INTO comments (workspace_id, doc_id, author_id, body) VALUES ($1, $2, $3, '{}'::jsonb)")
    .bind(workspace_id)
    .bind(doc_id)
    .bind(actor_id)
    .execute(pool)
    .await
    .expect("insert comment");

  sqlx::query(
    "INSERT INTO search_content (workspace_id, doc_id, title, plain_text) VALUES ($1, $2, 'title', 'content')",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .execute(pool)
  .await
  .expect("insert FK-backed search document");

  let context_id = Uuid::new_v4();
  sqlx::query("INSERT INTO copilot_contexts (id, user_id, workspace_id, name) VALUES ($1, $2, $3, 'delete context')")
    .bind(context_id)
    .bind(actor_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("insert copilot context");
  sqlx::query("INSERT INTO copilot_context_items (context_id, item_type, item_ref) VALUES ($1, 'doc', $2)")
    .bind(context_id)
    .bind(external_id)
    .execute(pool)
    .await
    .expect("insert copilot context item");
}

async fn row_count(pool: &sqlx::PgPool, table: &str, doc_id: Uuid) -> i64 {
  let sql = match table {
    "docs" => "SELECT COUNT(*) FROM docs WHERE id = $1",
    "doc_updates" => "SELECT COUNT(*) FROM doc_updates WHERE doc_id = $1",
    "doc_snapshots" => "SELECT COUNT(*) FROM doc_snapshots WHERE doc_id = $1",
    "doc_histories" => "SELECT COUNT(*) FROM doc_histories WHERE doc_id = $1",
    "document_version" => "SELECT COUNT(*) FROM document_version WHERE doc_id = $1",
    "doc_user_permissions" => "SELECT COUNT(*) FROM doc_user_permissions WHERE doc_id = $1",
    "comments" => "SELECT COUNT(*) FROM comments WHERE doc_id = $1",
    "search_content" => "SELECT COUNT(*) FROM search_content WHERE doc_id = $1",
    _ => panic!("unexpected table {table}"),
  };
  sqlx::query_scalar(sql)
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .unwrap_or_else(|error| panic!("count {table}: {error}"))
}

fn delete_payload(document_fields: &str, mutation_name: &str, input_type: &str) -> String {
  format!(
    r#"mutation Delete($input: {input_type}!) {{
      {mutation_name}(input: $input) {{
        requested deleted notFound forbidden alreadyDeleted notTrashed failed rootMetaRemoved
        documents {{ {document_fields} }}
      }}
    }}"#
  )
}

fn assert_no_graphql_errors(response: &Value, label: &str) {
  assert!(response.get("errors").is_none(), "{label} returned errors: {response}");
}

#[tokio::test]
async fn permanent_delete_single_original_id_removes_db_dependents_and_root_meta() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_single").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let target_original_id = format!("docdel-target-{workspace_id}");
  let survivor_original_id = format!("docdel-survivor-{workspace_id}");
  let target_doc_id = insert_original_doc(&pool, workspace_id, owner_id, &target_original_id).await;
  let _survivor_doc_id = insert_original_doc(&pool, workspace_id, owner_id, &survivor_original_id).await;

  insert_delete_dependents(&pool, workspace_id, target_doc_id, &target_original_id, owner_id).await;
  push_root_meta(
    &pool,
    workspace_id,
    &[(&target_original_id, true), (&survivor_original_id, false)],
  )
  .await;

  let organizer_id = Uuid::new_v4();
  let organizer = Doc::new();
  let index = organizer.get_or_insert_map("myoxus$mcp_folder_index");
  for (entry_id, key) in [
    ("deleted-entry", target_original_id.as_str()),
    ("survivor-entry", survivor_original_id.as_str()),
  ] {
    let row = organizer.get_or_insert_map(entry_id);
    let mut txn = organizer.transact_mut();
    for (field, value) in [
      ("id", entry_id),
      ("parentId", "folder"),
      ("type", "doc"),
      ("data", key),
      ("index", "a0"),
    ] {
      row.insert(&mut txn, field, value);
    }
    index.insert(&mut txn, entry_id, true);
  }
  sqlx::query(
    "INSERT INTO docs (id,workspace_id,external_id,title,created_by,updated_by) VALUES ($1,$2,$3,'Organizer',$4,$4)",
  )
  .bind(organizer_id)
  .bind(workspace_id)
  .bind(format!("db${workspace_id}$folders"))
  .bind(owner_id)
  .execute(&pool)
  .await
  .unwrap();
  let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  service
    .push_update(
      workspace_id,
      organizer_id,
      organizer.transact().encode_state_as_update_v1(&Default::default()),
      1,
      DocSpaceKind::Workspace,
    )
    .await
    .unwrap();

  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId title status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": target_original_id } }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "deleteDocumentPermanently");

  let payload = &response["data"]["deleteDocumentPermanently"];
  assert_eq!(payload["requested"], 1);
  assert_eq!(payload["deleted"], 1);
  assert_eq!(payload["rootMetaRemoved"], 1);
  assert_eq!(payload["documents"][0]["status"], "Deleted");
  assert_eq!(payload["documents"][0]["clientDocId"], target_original_id);
  let after = Doc::new();
  after
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&service.load_full_doc(workspace_id, organizer_id).await.unwrap()).unwrap())
    .unwrap();
  let txn = after.transact();
  let deleted = txn.get_map("deleted-entry").unwrap();
  assert!(
    deleted.get(&txn, "data").is_none(),
    "successful deletion must remove canonical Organizer target fields"
  );
  assert!(matches!(
    deleted.get(&txn, "$$DELETED"),
    Some(yrs::Out::Any(Any::Bool(true)))
  ));
  let index = txn.get_map("myoxus$mcp_folder_index").unwrap();
  assert!(index.get(&txn, "deleted-entry").is_none());
  assert!(index.get(&txn, "survivor-entry").is_some());
  drop(txn);
  let delivered: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='workspace_doc_broadcast' AND payload->>'lifecycleOperation'='document_permanent_delete')")
    .bind(target_doc_id.to_string()).fetch_one(&pool).await.unwrap();
  assert!(
    delivered,
    "Organizer retirement must use the normal durable realtime delivery path"
  );
  // Emulate the persisted reference left by an older release, bypassing the
  // new ingress normalization only in this fixture. Startup catch-up must
  // delete it automatically and a second pass must write nothing.
  let legacy = Doc::new();
  let legacy_row = legacy.get_or_insert_map("legacy-deleted-entry");
  {
    let mut txn = legacy.transact_mut();
    legacy_row.insert(&mut txn, "id", "legacy-deleted-entry");
    legacy_row.insert(&mut txn, "type", "doc");
    legacy_row.insert(&mut txn, "data", target_doc_id.to_string());
  }
  let legacy_payload = legacy.transact().encode_state_as_update_v1(&Default::default());
  sqlx::query("INSERT INTO doc_updates (doc_id,workspace_id,payload,sequence) SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1 FROM doc_updates WHERE doc_id=$1")
    .bind(organizer_id).bind(workspace_id).bind(legacy_payload).execute(&pool).await.unwrap();
  let store = SqlxDocStore::new(pool.clone());
  assert!(
    store
      .purge_workspace_deleted_organizer_links(workspace_id)
      .await
      .unwrap()
  );
  assert!(
    !store
      .purge_workspace_deleted_organizer_links(workspace_id)
      .await
      .unwrap()
  );
  // A delayed client can contain a completely new row, unseen at delete time.
  // Its accepted update and the removal must be delivered in the same commit.
  let late = Doc::new();
  let row = late.get_or_insert_map("late-deleted-entry");
  {
    let mut txn = late.transact_mut();
    row.insert(&mut txn, "id", "late-deleted-entry");
    row.insert(&mut txn, "type", "doc");
    row.insert(&mut txn, "data", target_original_id.as_str());
  }
  let late_payload = late.transact().encode_state_as_update_v1(&Default::default());
  service
    .push_update(workspace_id, organizer_id, late_payload, 1, DocSpaceKind::Workspace)
    .await
    .unwrap();
  let external = Doc::new();
  let row = external.get_or_insert_map("late-external-deleted-entry");
  {
    let mut txn = external.transact_mut();
    row.insert(&mut txn, "id", "late-external-deleted-entry");
    row.insert(&mut txn, "type", "doc");
    row.insert(&mut txn, "data", target_original_id.as_str());
  }
  service
    .push_external_update_raw(
      workspace_id,
      myoxus_domain::document_key::DocumentKey::parse(format!("db${workspace_id}$folders")).unwrap(),
      external.transact().encode_state_as_update_v1(&Default::default()),
      DocSpaceKind::Workspace,
    )
    .await
    .unwrap();
  let final_state = Doc::new();
  final_state
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&service.load_full_doc(workspace_id, organizer_id).await.unwrap()).unwrap())
    .unwrap();
  let txn = final_state.transact();
  for id in [
    "legacy-deleted-entry",
    "late-deleted-entry",
    "late-external-deleted-entry",
  ] {
    assert!(
      txn.get_map(id).unwrap().get(&txn, "data").is_none(),
      "deleted target survived in {id}"
    );
  }
  assert!(txn.get_map("survivor-entry").unwrap().get(&txn, "data").is_some());
  drop(txn);
  let evidence = sqlx::query_as::<_, (Uuid, String)>(
    "SELECT doc_id, state FROM page_registration_evidence WHERE workspace_id=$1 AND external_id=$2",
  )
  .bind(workspace_id)
  .bind(&target_original_id)
  .fetch_one(&pool)
  .await
  .unwrap();
  assert_eq!(
    evidence,
    (target_doc_id, "deleted".to_string()),
    "deleting a legacy page must retain its identity even without prior registration evidence"
  );

  for table in [
    "docs",
    "doc_updates",
    "doc_snapshots",
    "doc_histories",
    "document_version",
    "doc_user_permissions",
    "comments",
    "search_content",
  ] {
    assert_eq!(
      row_count(&pool, table, target_doc_id).await,
      0,
      "{table} must be cleared"
    );
  }

  let context_item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM copilot_context_items WHERE item_ref = $1")
    .bind(
      payload["documents"][0]["clientDocId"]
        .as_str()
        .expect("clientDocId string"),
    )
    .fetch_one(&pool)
    .await
    .expect("count copilot_context_items");
  assert_eq!(
    context_item_count, 0,
    "denormalized copilot context item must be cleared"
  );

  let root_ids = root_page_ids(&pool, workspace_id).await;
  assert!(
    !root_ids.contains(&target_original_id),
    "deleted page must be removed from root meta: {root_ids:?}"
  );
  assert!(
    root_ids.contains(&survivor_original_id),
    "survivor page must stay in root meta: {root_ids:?}"
  );

  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let loaded = doc_service
    .load_full_doc_with_meta(workspace_id, target_doc_id)
    .await
    .expect("direct load after permanent delete");
  assert!(
    !loaded.exists,
    "permanently deleted doc must not remain loadable as an existing document"
  );
  assert!(
    !loaded.has_real_content,
    "permanently deleted doc must not retain snapshot/update content"
  );

  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn permanent_delete_writes_document_audit_without_content_or_title_leaks() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let target_original_id = format!("docdel-audit-{workspace_id}");
  let target_doc_id = insert_original_doc(&pool, workspace_id, admin_id, &target_original_id).await;
  push_root_meta(&pool, workspace_id, &[(&target_original_id, true)]).await;

  let response = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": delete_payload("clientDocId resolvedDocId title status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": target_original_id } }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "deleteDocumentPermanently audit");

  let entry = sqlx::query(
    "SELECT event_key, category, target_type, target_id, target_label, old_value, new_value, metadata
     FROM admin_audit_log
     WHERE event_key = 'document.delete_permanent' AND target_id = $1
     ORDER BY created_at DESC
     LIMIT 1",
  )
  .bind(target_doc_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("document delete audit row");

  assert_eq!(entry.get::<String, _>("event_key"), "document.delete_permanent");
  assert_eq!(entry.get::<String, _>("category"), "document");
  assert_eq!(
    entry.get::<Option<String>, _>("target_type").as_deref(),
    Some("document")
  );
  assert_eq!(
    entry.get::<Option<String>, _>("target_id").as_deref(),
    Some(target_doc_id.to_string().as_str())
  );
  assert_eq!(entry.get::<Option<String>, _>("target_label"), None);
  let old_value = entry.get::<Option<Value>, _>("old_value").expect("old audit value");
  let metadata = entry.get::<Option<Value>, _>("metadata").expect("audit metadata");
  assert_eq!(old_value["requested"], 1);
  assert_eq!(old_value["rootMetaRemoved"], 1);
  assert_eq!(entry.get::<Option<Value>, _>("new_value"), None);
  assert_eq!(metadata["mode"], "single");
  assert_eq!(metadata["deleted"], 1);
  let serialized_entry = serde_json::json!({ "old": old_value, "metadata": metadata }).to_string();
  assert!(
    !serialized_entry.contains("page-docdel-audit"),
    "audit must not leak document titles: {serialized_entry}"
  );

  sqlx::query("DELETE FROM admin_audit_log WHERE event_key = 'document.delete_permanent'")
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn permanent_delete_denies_reader_without_mutating_doc_or_root_meta() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "docdel_reader_owner").await;
  let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "docdel_reader").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
     VALUES ($1, $2, 'Reader', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(reader_id)
  .execute(&pool)
  .await
  .expect("grant reader membership");

  let target_original_id = format!("docdel-reader-denied-{workspace_id}");
  let target_doc_id = insert_original_doc(&pool, workspace_id, owner_id, &target_original_id).await;
  push_root_meta(&pool, workspace_id, &[(&target_original_id, true)]).await;

  let response = helpers::gql(
    &app,
    reader_session,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": target_original_id } }
    }),
  )
  .await;
  assert!(
    response.get("errors").is_some(),
    "reader delete must be rejected before mutation: {response}"
  );
  assert_eq!(
    row_count(&pool, "docs", target_doc_id).await,
    1,
    "permission-denied delete must not remove the doc row"
  );
  let root_ids = root_page_ids(&pool, workspace_id).await;
  assert!(
    root_ids.contains(&target_original_id),
    "permission-denied delete must not mutate root meta: {root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
}

#[tokio::test]
async fn permanent_delete_allows_admin_and_collaborator_effective_editor_roles() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "docdel_role_owner").await;
  let (admin_id, admin_session) = helpers::seed_user(&pool, &auth_store, "docdel_role_admin").await;
  let (collab_id, collab_session) = helpers::seed_user(&pool, &auth_store, "docdel_role_collab").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  for (user_id, role) in [(admin_id, "Admin"), (collab_id, "Collaborator")] {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(role)
    .execute(&pool)
    .await
    .unwrap_or_else(|error| panic!("grant {role} membership: {error}"));
  }

  let admin_doc = format!("docdel-admin-role-{workspace_id}");
  let collab_doc = format!("docdel-collab-role-{workspace_id}");
  let admin_doc_uuid = insert_original_doc(&pool, workspace_id, owner_id, &admin_doc).await;
  let collab_doc_uuid = insert_original_doc(&pool, workspace_id, owner_id, &collab_doc).await;
  push_root_meta(&pool, workspace_id, &[(&admin_doc, true), (&collab_doc, true)]).await;

  for (session, doc_id, doc_uuid, role_label) in [
    (admin_session, admin_doc, admin_doc_uuid, "Admin"),
    (collab_session, collab_doc, collab_doc_uuid, "Collaborator"),
  ] {
    let response = helpers::gql(
      &app,
      session,
      json!({
        "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
        "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": doc_id } }
      }),
    )
    .await;
    assert_no_graphql_errors(&response, role_label);
    let payload = &response["data"]["deleteDocumentPermanently"];
    assert_eq!(payload["deleted"], 1, "{role_label} should be allowed to delete");
    assert_eq!(row_count(&pool, "docs", doc_uuid).await, 0);
  }

  let root_ids = root_page_ids(&pool, workspace_id).await;
  assert!(
    root_ids.is_empty(),
    "both role-matrix docs must be removed: {root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id, admin_id, collab_id]).await;
}

#[tokio::test]
async fn permanent_delete_stale_root_meta_without_doc_row_removes_visible_entry() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_stale_root").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let stale_original_id = format!("docdel-stale-root-{workspace_id}");
  push_root_meta(&pool, workspace_id, &[(&stale_original_id, true)]).await;

  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": stale_original_id } }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "delete stale root metadata");

  let payload = &response["data"]["deleteDocumentPermanently"];
  assert_eq!(payload["requested"], 1);
  assert_eq!(payload["deleted"], 0);
  assert_eq!(payload["alreadyDeleted"], 1);
  assert_eq!(payload["notFound"], 0);
  assert_eq!(payload["rootMetaRemoved"], 1);
  assert_eq!(payload["documents"][0]["status"], "AlreadyDeleted");

  let root_ids = root_page_ids(&pool, workspace_id).await;
  let deleted_client_doc_id = payload["documents"][0]["clientDocId"]
    .as_str()
    .expect("clientDocId string");
  assert!(
    !root_ids.iter().any(|id| id == deleted_client_doc_id),
    "stale visible root meta entry must be removed: {root_ids:?}"
  );

  let second_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": payload["documents"][0]["clientDocId"].as_str().expect("clientDocId string") } }
    }),
  )
  .await;
  assert_no_graphql_errors(&second_response, "delete stale root metadata twice");
  let second_payload = &second_response["data"]["deleteDocumentPermanently"];
  assert_eq!(second_payload["notFound"], 1);
  assert_eq!(second_payload["rootMetaRemoved"], 0);

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn empty_trash_root_cleanup_after_compaction_is_persisted_above_snapshot_sequence() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_compacted_root").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let stale_original_id = format!("docdel-compacted-stale-{workspace_id}");

  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
     VALUES ($1, $1, 'Workspace root', 'viewer', TRUE, $2, $2)
     ON CONFLICT (id) DO NOTHING",
  )
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert root doc row for compacted-root fixture");
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clear root updates before compacted-root fixture");
  sqlx::query("DELETE FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clear root snapshot before compacted-root fixture");
  sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $1, $2, 50)")
    .bind(workspace_id)
    .bind(build_root_doc_update(&[(&stale_original_id, true)]))
    .execute(&pool)
    .await
    .expect("insert compacted root snapshot");

  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "emptyWorkspaceTrash", "EmptyWorkspaceTrashInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string() } }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "emptyWorkspaceTrash compacted root cleanup");

  let payload = &response["data"]["emptyWorkspaceTrash"];
  assert_eq!(payload["requested"], 1);
  assert_eq!(payload["deleted"], 0);
  assert_eq!(payload["alreadyDeleted"], 1);
  assert_eq!(payload["rootMetaRemoved"], 1);
  assert_eq!(payload["documents"][0]["clientDocId"], stale_original_id);

  let cleanup_sequence: i64 =
    sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("load compacted root cleanup sequence");
  assert!(
    cleanup_sequence > 50,
    "root cleanup update must be newer than compacted snapshot last_sequence=50, got {cleanup_sequence}"
  );

  let loaded_root_ids = loaded_root_page_ids(&pool, workspace_id).await;
  assert!(
    !loaded_root_ids.contains(&stale_original_id),
    "load_full_doc must include the cleanup update after compaction: {loaded_root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn empty_trash_classifies_client_visible_local_trash_against_authoritative_root() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_client_visible_root").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let server_live_id = format!("docdel-live-{workspace_id}");
  let local_absent_id = format!("docdel-local-stale-{workspace_id}");
  let local_absent_system_id = format!("db${workspace_id}$folders");

  push_root_meta(&pool, workspace_id, &[(&server_live_id, false)]).await;

  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload(
        "clientDocId resolvedDocId status reason",
        "emptyWorkspaceTrash",
        "EmptyWorkspaceTrashInput"
      ),
      "variables": {
        "input": {
          "workspaceId": workspace_id.to_string(),
          "clientVisibleDocIds": [
            server_live_id,
            local_absent_id,
            local_absent_system_id
          ]
        }
      }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "emptyWorkspaceTrash client-visible reconciliation");

  let payload = &response["data"]["emptyWorkspaceTrash"];
  assert_eq!(payload["requested"], 3, "client-visible ids must be counted: {payload}");
  assert_eq!(
    payload["alreadyDeleted"], 2,
    "server-absent local trash ids must be removable locally: {payload}"
  );
  assert_eq!(
    payload["notTrashed"], 1,
    "server-live local trash ids must be restored locally: {payload}"
  );
  assert_eq!(payload["failed"], 0);
  assert_eq!(payload["forbidden"], 0);
  let documents = payload["documents"].as_array().expect("documents array");
  let status_by_id: HashMap<String, String> = documents
    .iter()
    .map(|doc| {
      (
        doc["clientDocId"].as_str().expect("clientDocId").to_string(),
        doc["status"].as_str().expect("status").to_string(),
      )
    })
    .collect();
  assert_eq!(
    status_by_id.get(&server_live_id).map(String::as_str),
    Some("NotTrashed")
  );
  assert_eq!(
    status_by_id.get(&local_absent_id).map(String::as_str),
    Some("AlreadyDeleted")
  );
  assert_eq!(
    status_by_id.get(&local_absent_system_id).map(String::as_str),
    Some("AlreadyDeleted")
  );

  let loaded_root_ids = loaded_root_page_ids(&pool, workspace_id).await;
  assert!(
    loaded_root_ids.contains(&server_live_id),
    "server-live document must remain in authoritative root: {loaded_root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn websocket_delete_doc_keeps_legacy_event_shape_and_uses_same_root_cleanup() {
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_ws").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let target_original_id = format!("docdel-ws-{workspace_id}");
  let target_doc_id = insert_original_doc(&pool, workspace_id, owner_id, &target_original_id).await;
  push_root_meta(&pool, workspace_id, &[(&target_original_id, true)]).await;

  let cookie = format!("affine_session={session_id}");
  let sender_sid = sio_connect_and_join(&app, &cookie, workspace_id).await;
  let observer_sid = sio_connect_and_join(&app, &cookie, workspace_id).await;

  let delete_payload = json!({
    "spaceType": "workspace",
    "spaceId": workspace_id.to_string(),
    "docId": target_original_id,
  });
  sio_post(
    &app,
    &sender_sid,
    &cookie,
    format!(r#"42["space:delete-doc",{}]"#, delete_payload),
  )
  .await;

  let broadcast = sio_poll_for(&app, &observer_sid, &cookie, &["space:doc-delete"]).await;
  assert!(
    broadcast.contains("space:doc-delete"),
    "legacy websocket delete must still broadcast space:doc-delete, got: {broadcast}"
  );
  assert!(
    broadcast.contains(&target_original_id),
    "legacy websocket delete payload must keep client doc id shape, got: {broadcast}"
  );
  assert_eq!(row_count(&pool, "docs", target_doc_id).await, 0);
  let root_ids = root_page_ids(&pool, workspace_id).await;
  assert!(
    !root_ids.contains(&target_original_id),
    "websocket delete must use same server root-meta cleanup as GraphQL: {root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn permanent_delete_bulk_empty_trash_cross_workspace_and_idempotency_are_structured() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_bulk").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let bulk_a = format!("docdel-bulk-a-{workspace_id}");
  let bulk_b = format!("docdel-bulk-b-{workspace_id}");
  let empty_only = format!("docdel-empty-{workspace_id}");
  let stale_root_only = format!("docdel-stale-root-{workspace_id}");
  let other_doc = format!("docdel-other-{other_workspace_id}");
  let bulk_a_uuid = insert_original_doc(&pool, workspace_id, owner_id, &bulk_a).await;
  let bulk_b_uuid = insert_original_doc(&pool, workspace_id, owner_id, &bulk_b).await;
  let empty_uuid = insert_original_doc(&pool, workspace_id, owner_id, &empty_only).await;
  let _other_uuid = insert_original_doc(&pool, other_workspace_id, owner_id, &other_doc).await;

  push_root_meta(
    &pool,
    workspace_id,
    &[
      (&bulk_a, true),
      (&bulk_b, true),
      (&empty_only, true),
      (&stale_root_only, true),
    ],
  )
  .await;
  push_root_meta(&pool, other_workspace_id, &[(&other_doc, true)]).await;

  let bulk_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentsPermanently", "DeleteDocumentsPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docIds": [bulk_a, bulk_b, other_doc] } }
    }),
  )
  .await;
  assert_no_graphql_errors(&bulk_response, "deleteDocumentsPermanently");
  let bulk_payload = &bulk_response["data"]["deleteDocumentsPermanently"];
  assert_eq!(bulk_payload["requested"], 3);
  assert_eq!(bulk_payload["deleted"], 2);
  assert_eq!(bulk_payload["notFound"], 1);
  assert_eq!(bulk_payload["rootMetaRemoved"], 2);

  assert_eq!(row_count(&pool, "docs", bulk_a_uuid).await, 0);
  assert_eq!(row_count(&pool, "docs", bulk_b_uuid).await, 0);
  assert_eq!(row_count(&pool, "docs", empty_uuid).await, 1);

  let second_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "deleteDocumentPermanently", "DeleteDocumentPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": bulk_a } }
    }),
  )
  .await;
  assert_no_graphql_errors(&second_response, "idempotent deleteDocumentPermanently");
  let second_payload = &second_response["data"]["deleteDocumentPermanently"];
  assert_eq!(second_payload["requested"], 1);
  assert_eq!(second_payload["notFound"], 1);
  assert_eq!(second_payload["documents"][0]["status"], "NotFound");

  let empty_response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId resolvedDocId status reason", "emptyWorkspaceTrash", "EmptyWorkspaceTrashInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string() } }
    }),
  )
  .await;
  assert_no_graphql_errors(&empty_response, "emptyWorkspaceTrash");
  let empty_payload = &empty_response["data"]["emptyWorkspaceTrash"];
  assert_eq!(empty_payload["requested"], 2);
  assert_eq!(empty_payload["deleted"], 1);
  assert_eq!(empty_payload["alreadyDeleted"], 1);
  assert_eq!(empty_payload["rootMetaRemoved"], 2);
  assert_eq!(row_count(&pool, "docs", empty_uuid).await, 0);

  let root_ids = root_page_ids(&pool, workspace_id).await;
  assert!(
    root_ids.is_empty(),
    "all trashed root meta entries should be removed: {root_ids:?}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn graphql_deletion_notifies_clients_and_reconnect_distinguishes_deleted_from_unknown() {
  let (app, pool, auth_store) = helpers::setup_app_with_socket_io_handle().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "docdel_reconnect").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let target = format!("deleted-{workspace_id}");
  let target_id = insert_original_doc(&pool, workspace_id, owner_id, &target).await;
  push_root_meta(&pool, workspace_id, &[(&target, true)]).await;
  let cookie = format!("affine_session={session_id}");
  let sid = sio_connect_and_join(&app, &cookie, workspace_id).await;
  let response = helpers::gql(
    &app,
    session_id,
    json!({
      "query": delete_payload("clientDocId status", "deleteDocumentsPermanently", "DeleteDocumentsPermanentlyInput"),
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docIds": [&target] } }
    }),
  )
  .await;
  assert_no_graphql_errors(&response, "permanent delete");
  assert_eq!(response["data"]["deleteDocumentsPermanently"]["deleted"], 1);
  let broadcast = sio_poll_for(&app, &sid, &cookie, &["space:doc-delete"]).await;
  assert!(
    broadcast.contains("space:doc-delete")
      && broadcast.contains(&target)
      && broadcast.contains(&workspace_id.to_string()),
    "missing scoped server deletion notification: {broadcast}"
  );
  assert_eq!(row_count(&pool, "docs", target_id).await, 0);
  // A fresh socket did not receive the deletion event and must obtain the same decision on load.
  let reopened = sio_connect_and_join(&app, &cookie, workspace_id).await;
  for (ack, key, expected) in [
    (71, target.as_str(), "DOC_DELETED"),
    (72, "never-created", "DOC_NOT_FOUND"),
  ] {
    let payload = json!({ "spaceType": "workspace", "spaceId": workspace_id.to_string(), "docId": key });
    sio_post(
      &app,
      &reopened,
      &cookie,
      format!("42{ack}[\"space:load-doc\",{payload}]"),
    )
    .await;
    let result = sio_poll_for(&app, &reopened, &cookie, &[expected]).await;
    assert!(result.contains(expected), "wrong lifecycle decision: {result}");
  }
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
