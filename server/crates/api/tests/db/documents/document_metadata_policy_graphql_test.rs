// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for document metadata, status transitions and admin policy GraphQL surfaces.
//!
//! The old Myoxus-internal `documentAttributes` read/write names are intentionally
//! not exercised here. Runtime clients use the native `documentMetadata` contract;
//! status changes remain transition-only.

use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Mutex;
use uuid::Uuid;

use std::sync::OnceLock;

static DOCUMENT_METADATA_POLICY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[tokio::test]
async fn inv_docmeta_okf_status_mapping_is_editable_preserved_and_admin_owned() {
  use futures_util::FutureExt;
  let _lock = policy_lock().lock().await;
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (admin, session) = crate::helpers::seed_admin(&pool, &auth_store).await;
  let (user, user_session) = crate::helpers::seed_user(&pool, &auth_store, "okf-non-admin").await;
  let schema = Uuid::new_v4();
  let key = format!("okf-{schema}");
  let result = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO document_status_schema(id,key,label,complexity) VALUES($1,$2,'Mapping fixture','custom')")
      .bind(schema).bind(&key).execute(&pool).await.unwrap();
    let query = "mutation($input:AdminUpsertDocumentStatusValueInput!){admin{upsertDocumentStatusValue(input:$input){id key label terminal okfStatus}}}";
    let mut input = json!({"schemaId":schema,"key":"custom","label":"Custom","terminal":true});
    let created = crate::helpers::gql(&app,session,json!({"query":query,"variables":{"input":input}})).await;
    assert!(created.get("errors").is_none(),"{created}");
    assert_eq!(created["data"]["admin"]["upsertDocumentStatusValue"]["okfStatus"],"draft");
    let id = created["data"]["admin"]["upsertDocumentStatusValue"]["id"].clone();
    input["id"] = id.clone();
    input["okfStatus"] = json!("stable");
    let updated = crate::helpers::gql(&app,session,json!({"query":query,"variables":{"input":input}})).await;
    assert!(updated.get("errors").is_none(),"{updated}");
    assert_eq!(updated["data"]["admin"]["upsertDocumentStatusValue"]["okfStatus"],"stable");
    input.as_object_mut().unwrap().remove("okfStatus");
    input["label"] = json!("Renamed label");
    input["terminal"] = json!(false);
    let omitted = crate::helpers::gql(&app,session,json!({"query":query,"variables":{"input":input}})).await;
    assert!(omitted.get("errors").is_none(),"{omitted}");
    assert_eq!(omitted["data"]["admin"]["upsertDocumentStatusValue"]["okfStatus"],"stable");
    input["okfStatus"] = json!("invalid");
    let invalid = crate::helpers::gql(&app,session,json!({"query":query,"variables":{"input":input}})).await;
    assert!(invalid.get("errors").is_some(),"invalid mapping was accepted: {invalid}");
    input["okfStatus"] = json!("deprecated");
    let denied = crate::helpers::gql(&app,user_session,json!({"query":query,"variables":{"input":input}})).await;
    assert!(denied.get("errors").is_some(),"non-admin mapping edit was accepted");
    let read = crate::helpers::gql(&app,session,json!({"query":"query($key:String!){admin{documentStatusValues(schemaKey:$key){id okfStatus label terminal}}}","variables":{"key":key}})).await;
    assert_eq!(read["data"]["admin"]["documentStatusValues"][0]["okfStatus"],"stable");
    assert_eq!(read["data"]["admin"]["documentStatusValues"][0]["label"],"Renamed label");
    assert_eq!(read["data"]["admin"]["documentStatusValues"][0]["terminal"],false);
    let seeded: String = sqlx::query_scalar("SELECT okf_status FROM document_status_value WHERE id='3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a'")
      .fetch_one(&pool).await.unwrap();
    assert_eq!(seeded,"stable");
    let archived: String = sqlx::query_scalar("SELECT okf_status FROM document_status_value WHERE id='54532737-b096-4afa-911f-20a9e74d6d04'")
      .fetch_one(&pool).await.unwrap();
    assert_eq!(archived,"deprecated");
  }).catch_unwind().await;
  sqlx::query("DELETE FROM document_status_schema WHERE id=$1")
    .bind(schema)
    .execute(&pool)
    .await
    .expect("catalog cleanup");
  crate::helpers::cleanup_users(&pool, &[admin, user]).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

fn policy_lock() -> &'static Mutex<()> {
  DOCUMENT_METADATA_POLICY_LOCK.get_or_init(|| Mutex::new(()))
}

async fn status_id(pool: &PgPool, schema_key: &str, status_key: &str) -> Uuid {
  sqlx::query_scalar(
    "SELECT v.id \
     FROM document_status_value v \
     JOIN document_status_schema s ON s.id = v.schema_id \
     WHERE s.key = $1 AND v.key = $2",
  )
  .bind(schema_key)
  .bind(status_key)
  .fetch_one(pool)
  .await
  .expect("status id")
}

async fn status_schema_id(pool: &PgPool, schema_key: &str) -> Uuid {
  sqlx::query_scalar("SELECT id FROM document_status_schema WHERE key = $1")
    .bind(schema_key)
    .fetch_one(pool)
    .await
    .expect("status schema id")
}

async fn document_type_id(pool: &PgPool, key: &str) -> Uuid {
  sqlx::query_scalar("SELECT id FROM document_type_definition WHERE key = $1")
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("document type id")
}

async fn attribute_value_id(pool: &PgPool, field_key: &str, key: &str) -> Uuid {
  let query = match field_key {
    "classification" => "SELECT id FROM document_classification_definition WHERE key = $1",
    "audience" => "SELECT id FROM document_audience_definition WHERE key = $1",
    "retentionPolicy" => "SELECT id FROM document_retention_policy_definition WHERE key = $1",
    "language" => "SELECT id FROM language_definition WHERE key = $1",
    _ => panic!("unsupported typed document metadata value list: {field_key}"),
  };
  sqlx::query_scalar(query)
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("attribute value id")
}

async fn set_state_status(pool: &PgPool, doc_id: Uuid, status_id: Uuid, actor_id: Uuid) {
  sqlx::query("UPDATE docs SET status_id = $2, metadata_updated_by = $3 WHERE id = $1 AND deleted_at IS NULL")
    .bind(doc_id)
    .bind(status_id)
    .bind(actor_id)
    .execute(pool)
    .await
    .expect("set document metadata state status");
}

async fn insert_doc_with_id(pool: &PgPool, doc_id: Uuid, workspace_id: Uuid, created_by: Uuid) {
  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, $3, 'viewer', FALSE, $4, $4)"#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("doc-{doc_id}"))
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert doc with explicit id");
}

async fn create_custom_status_pair(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
  let suffix = Uuid::new_v4().simple().to_string();
  let schema_key = format!("test_required_attr_{suffix}");
  let schema_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_schema (key, label, complexity, is_preset, is_active) \
     VALUES ($1, $2, 'custom', false, true) RETURNING id",
  )
  .bind(&schema_key)
  .bind(format!("Test required attribute {suffix}"))
  .fetch_one(pool)
  .await
  .expect("insert custom schema");
  let from_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'from', 'From', 10) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert from status");
  let to_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_status_value (schema_id, key, label, sort_order) VALUES ($1, 'to', 'To', 20) RETURNING id",
  )
  .bind(schema_id)
  .fetch_one(pool)
  .await
  .expect("insert to status");
  sqlx::query(
    "INSERT INTO document_status_transition (from_status_id, to_status_id, required_metadata_fields) \
     VALUES ($1, $2, ARRAY['classification']::text[])",
  )
  .bind(from_id)
  .bind(to_id)
  .execute(pool)
  .await
  .expect("insert required-attribute transition");
  (schema_id, from_id, to_id)
}

async fn add_workspace_member(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, $3, 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(role)
  .execute(pool)
  .await
  .expect("insert workspace membership");
}

fn metadata_field<'a>(body: &'a Value, pointer: &str, key: &str) -> &'a Value {
  body
    .pointer(pointer)
    .and_then(Value::as_array)
    .and_then(|items| items.iter().find(|item| item["key"] == key))
    .unwrap_or_else(|| panic!("metadata attribute '{key}' missing at {pointer}: {body}"))
}

fn metadata_field_ref_id<'a>(body: &'a Value, pointer: &str, key: &str) -> Option<&'a str> {
  metadata_field(body, pointer, key)
    .pointer("/reference/id")
    .and_then(Value::as_str)
}

fn metadata_field_ref_key<'a>(body: &'a Value, pointer: &str, key: &str) -> Option<&'a str> {
  metadata_field(body, pointer, key)
    .pointer("/reference/key")
    .and_then(Value::as_str)
}

#[tokio::test]
async fn inv_docmeta_gql01_non_member_cannot_read_document_metadata() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, _owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql01").await;
  let (outsider_id, outsider_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-outsider-gql01").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let body = crate::helpers::gql_with_headers(
    &app,
    outsider_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { docId fields { key reference { id } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_some(),
    "non-member must not read native document metadata: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id, outsider_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql02_workspace_member_reads_effective_metadata() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql02").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { docId workspaceId fields { key reference { id key } } } documentMetadataValidation(workspaceId: $workspaceId, docId: $docId) { valid } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "member must read effective native metadata: {body}"
  );
  assert_eq!(
    body.pointer("/data/documentMetadata/docId").and_then(Value::as_str),
    Some(doc_id.to_string().as_str())
  );
  assert!(metadata_field_ref_id(&body, "/data/documentMetadata/fields", "status").is_some());
  assert_eq!(
    metadata_field_ref_key(&body, "/data/documentMetadata/fields", "status"),
    Some("in_progress")
  );
  assert_eq!(
    body
      .pointer("/data/documentMetadataValidation/valid")
      .and_then(Value::as_bool),
    Some(true)
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql03_set_document_metadata_persists_canonical_fields() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql03").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let type_id = document_type_id(&pool, "concept").await;
  let classification_id = attribute_value_id(&pool, "classification", "internal").await;

  let language_id = attribute_value_id(&pool, "language", "de").await;

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision metadataUpdatedBy fields { key reference { id key } textValue timestampValue userId } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "documentTypeId": type_id.to_string(),
          "responsibleUserId": owner_id.to_string(),
          "reviewDueAt": "2026-06-01T00:00:00Z",
          "classificationId": classification_id.to_string(),
          "documentNumber": "DOC-42",
          "languageId": language_id.to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "setDocumentMetadata must persist canonical fields: {body}"
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/setDocumentMetadata/metadata/fields", "documentType"),
    Some(type_id.to_string().as_str())
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/setDocumentMetadata/metadata/fields", "classification"),
    Some(classification_id.to_string().as_str())
  );
  assert_eq!(
    metadata_field(&body, "/data/setDocumentMetadata/metadata/fields", "documentNumber")
      .pointer("/textValue")
      .and_then(Value::as_str),
    Some("DOC-42")
  );
  assert_eq!(
    metadata_field_ref_key(&body, "/data/setDocumentMetadata/metadata/fields", "language"),
    Some("de")
  );
  assert!(
    body
      .pointer("/data/setDocumentMetadata/metadata/metadataRevision")
      .and_then(Value::as_i64)
      .is_some_and(|revision| revision >= 1),
    "metadata write must advance freshness: {body}"
  );
  let row: (Option<Uuid>, Option<Uuid>, Option<String>, Option<Uuid>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
    "SELECT document_type_id, classification_id, document_number, metadata_updated_by, language_id, responsible_user_id FROM docs WHERE id = $1",
  )
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read canonical document metadata");
  assert_eq!(row.0, Some(type_id));
  assert_eq!(row.1, Some(classification_id));
  assert_eq!(row.2.as_deref(), Some("DOC-42"));
  assert_eq!(row.3, Some(owner_id));
  assert_eq!(row.4, Some(language_id));
  assert_eq!(row.5, Some(owner_id));
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql03b_document_metadata_mutations_accept_client_doc_ids() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql03b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let client_doc_id = format!("DocAttrNanoid{}", Uuid::new_v4().simple());
  let doc_id = Uuid::new_v4();
  insert_doc_with_id(&pool, doc_id, workspace_id, owner_id).await;
  sqlx::query("UPDATE docs SET external_id = $1 WHERE id = $2")
    .bind(&client_doc_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("assign client document key");
  let classification_id = attribute_value_id(&pool, "classification", "internal").await;
  let from_id = status_id(&pool, "simple", "in_progress").await;
  let to_id = status_id(&pool, "simple", "current").await;
  set_state_status(&pool, doc_id, from_id, owner_id).await;

  let read_body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { docId fields { key reference { id } } } documentMetadataValidation(workspaceId: $workspaceId, docId: $docId, action: export_pdf) { valid blockedActions } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": client_doc_id }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    read_body.get("errors").is_none(),
    "document metadata reads must accept canonical Web client doc IDs: {read_body}"
  );
  assert_eq!(
    read_body
      .pointer("/data/documentMetadata/docId")
      .and_then(Value::as_str),
    Some(doc_id.to_string().as_str())
  );

  let set_body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { docId fields { key reference { id } } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": client_doc_id,
        "input": { "classificationId": classification_id.to_string() }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    set_body.get("errors").is_none(),
    "setDocumentMetadata must accept canonical Web client doc IDs: {set_body}"
  );
  assert_eq!(
    metadata_field_ref_id(&set_body, "/data/setDocumentMetadata/metadata/fields", "classification"),
    Some(classification_id.to_string().as_str())
  );

  let transition_body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid } metadata { fields { key reference { id } } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": client_doc_id, "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;
  assert!(
    transition_body.get("errors").is_none(),
    "transitionDocumentStatus must accept canonical Web client doc IDs: {transition_body}"
  );
  assert_eq!(
    transition_body
      .pointer("/data/transitionDocumentStatus/validation/valid")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    metadata_field_ref_id(
      &transition_body,
      "/data/transitionDocumentStatus/metadata/fields",
      "status"
    ),
    Some(to_id.to_string().as_str())
  );
  let persisted: (Option<Uuid>, String) = sqlx::query_as("SELECT status_id, status_source FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read canonical transition target");
  assert_eq!(persisted.0, Some(to_id));
  assert_eq!(
    persisted.1, "document",
    "transitionDocumentStatus must mark docs.status_id as the explicit document value"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql04_set_document_metadata_input_rejects_status_id() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql04").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let status_id = status_id(&pool, "simple", "current").await;

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "statusId": status_id.to_string() } }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_some()
      && body["errors"][0]["message"]
        .as_str()
        .is_some_and(|message| message.contains("statusId")),
    "statusId must be rejected by the native metadata schema: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05_transition_blocks_without_edge() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let from_id = status_id(&pool, "simple", "in_progress").await;
  let to_id = status_id(&pool, "simple", "archived").await;
  set_state_status(&pool, doc_id, from_id, owner_id).await;

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;

  assert_eq!(
    body.pointer("/errors/0/extensions/code").and_then(Value::as_str),
    Some("DOCUMENT_STATUS_TRANSITION_BLOCKED"),
    "missing transition edge must be blocked: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql06_transition_blocks_missing_required_metadata_field() {
  let _guard = policy_lock().lock().await;
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql06").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let (schema_id, from_id, to_id) = create_custom_status_pair(&pool).await;
  set_state_status(&pool, doc_id, from_id, owner_id).await;
  sqlx::query("UPDATE docs SET classification_id = NULL, classification_source = 'document' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("clear classification to exercise required-metadata validation");

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid missingRequiredMetadataFields errors { code key blockedActions } } metadata { fields { key reference { id } } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "validation-blocked transition must return payload: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/transitionDocumentStatus/validation/valid")
      .and_then(Value::as_bool),
    Some(false)
  );
  assert_eq!(
    body
      .pointer("/data/transitionDocumentStatus/validation/missingRequiredMetadataFields/0")
      .and_then(Value::as_str),
    Some("classification")
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/transitionDocumentStatus/metadata/fields", "status"),
    Some(from_id.to_string().as_str())
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
  sqlx::query("DELETE FROM document_status_schema WHERE id = $1")
    .bind(schema_id)
    .execute(&pool)
    .await
    .ok();
}

#[tokio::test]
async fn inv_docmeta_gql06b_transition_uses_effective_default_status_for_new_documents() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql06b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let from_id = status_id(&pool, "simple", "in_progress").await;
  let to_id = status_id(&pool, "simple", "current").await;

  let before: (Option<Uuid>, String) = sqlx::query_as("SELECT status_id, status_source FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read initial canonical document status");
  assert_eq!(
    before,
    (Some(from_id), "organization".to_string()),
    "new documents must materialize the effective default status canonically"
  );

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid errors { code key } } metadata { fields { key reference { id } } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "transition from effective default state must succeed: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/transitionDocumentStatus/validation/valid")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/transitionDocumentStatus/metadata/fields", "status"),
    Some(to_id.to_string().as_str())
  );
  let persisted_from: Option<Uuid> = sqlx::query_scalar("SELECT status_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read transitioned canonical document status");
  assert_ne!(
    persisted_from,
    Some(from_id),
    "default start state must only be a transition base, not the final persisted status"
  );
  assert_eq!(persisted_from, Some(to_id));
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql06c_transition_uses_effective_default_status_after_attribute_patch() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql06c").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let classification_id = attribute_value_id(&pool, "classification", "internal").await;
  let to_id = status_id(&pool, "simple", "current").await;

  let patch_body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { fields { key reference { id } } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "classificationId": classification_id.to_string() } }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    patch_body.get("errors").is_none(),
    "normal attribute patch must succeed before status transition: {patch_body}"
  );
  let persisted_status: (Option<Uuid>, String) =
    sqlx::query_as("SELECT status_id, status_source FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read patched canonical document status");
  assert_eq!(
    persisted_status,
    (
      Some(status_id(&pool, "simple", "in_progress").await),
      "organization".to_string()
    ),
    "normal attribute patches must preserve the materialized default status instead of creating a legacy state row"
  );
  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid errors { code key } } metadata { fields { key reference { id } } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "transition must use effective default status even after a non-status patch created the state row: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/transitionDocumentStatus/validation/valid")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/transitionDocumentStatus/metadata/fields", "status"),
    Some(to_id.to_string().as_str())
  );
  assert_eq!(
    metadata_field_ref_id(
      &body,
      "/data/transitionDocumentStatus/metadata/fields",
      "classification"
    ),
    Some(classification_id.to_string().as_str())
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql07_required_transition_creates_version_and_updates_pointer() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql07").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let from_id = status_id(&pool, "review", "in_review").await;
  let to_id = status_id(&pool, "review", "approved").await;
  set_state_status(&pool, doc_id, from_id, owner_id).await;

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) { transitionDocumentStatus(workspaceId: $workspaceId, docId: $docId, input: $input) { validation { valid errors { code key } } metadata { fields { key reference { id } textValue } } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "input": { "toStatusId": to_id.to_string() } }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "required version transition must succeed: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/transitionDocumentStatus/validation/valid")
      .and_then(Value::as_bool),
    Some(true)
  );
  assert_eq!(
    metadata_field_ref_id(&body, "/data/transitionDocumentStatus/metadata/fields", "status"),
    Some(to_id.to_string().as_str())
  );
  let version_field = metadata_field(&body, "/data/transitionDocumentStatus/metadata/fields", "version");
  assert!(
    version_field.pointer("/textValue").and_then(Value::as_str).is_some(),
    "version-producing transition must expose the native version metadata attribute: {body}"
  );
  let current_version_id: Option<Uuid> = sqlx::query_scalar("SELECT current_version_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read current version pointer");
  assert!(
    current_version_id.is_some(),
    "version-producing transition must update docs.current_version_id"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[test]
fn inv_docmeta_gql08_global_admin_can_update_metadata_policy() {
  crate::helpers::block_on_large_stack("inv_docmeta_gql08_global_admin_can_update_metadata_policy", || async {
    let _guard = policy_lock().lock().await;
    let (app, pool, auth_store) = crate::helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = crate::helpers::seed_admin(&pool, &auth_store).await;
    let original_visible: bool =
      sqlx::query_scalar("SELECT visible_in_header FROM document_metadata_field_definition WHERE key = 'language'")
        .fetch_one(&pool)
        .await
        .expect("original visible flag");
    let target_visible = !original_visible;

    let body = crate::helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) { admin { updateDocumentMetadataFieldDefinition(input: $input) { key visibleInHeader } } }",
        "variables": { "input": { "key": "language", "visibleInHeader": target_visible } }
      }),
    )
    .await;

    assert!(
      body.get("errors").is_none(),
      "global admin must update metadata policy: {body}"
    );
    assert_eq!(
      body
        .pointer("/data/admin/updateDocumentMetadataFieldDefinition/visibleInHeader")
        .and_then(Value::as_bool),
      Some(target_visible)
    );
    let audit_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM admin_audit_log \
       WHERE event_key = 'document_metadata.policy.update' \
         AND target_type = 'document_metadata_policy' \
         AND target_id = 'language' \
         AND actor_user_id = $1",
    )
    .bind(admin_id)
    .fetch_one(&pool)
    .await
    .expect("count document metadata policy audit rows");
    assert_eq!(audit_count, 1, "policy update must write one admin_audit_log row");
    sqlx::query("UPDATE document_metadata_field_definition SET visible_in_header = $1 WHERE key = 'language'")
      .bind(original_visible)
      .execute(&pool)
      .await
      .expect("restore visible flag");
    sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(admin_id)
      .execute(&pool)
      .await
      .ok();
    crate::helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_docmeta_gql09_workspace_admin_cannot_update_global_policy() {
  crate::helpers::block_on_large_stack(
    "inv_docmeta_gql09_workspace_admin_cannot_update_global_policy",
    || async {
      inv_docmeta_gql09_workspace_admin_cannot_update_global_policy_inner().await;
    },
  );
}

async fn inv_docmeta_gql09_workspace_admin_cannot_update_global_policy_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, _owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql09").await;
  let (workspace_admin_id, workspace_admin_session) =
    crate::helpers::seed_user(&pool, &auth_store, "docmeta-ws-admin-gql09").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  add_workspace_member(&pool, workspace_id, workspace_admin_id, "Admin").await;

  let body = crate::helpers::gql(
    &app,
    workspace_admin_session,
    json!({
      "query": "mutation M($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) { admin { updateDocumentMetadataFieldDefinition(input: $input) { key visibleInHeader } } }",
      "variables": { "input": { "key": "language", "visibleInHeader": true } }
    }),
  )
  .await;

  assert!(
    body.get("errors").is_some(),
    "workspace admin must not update global policy: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id, workspace_admin_id]).await;
}

#[test]
fn inv_docmeta_gql10_workspace_admin_updates_settings_collaborator_cannot() {
  crate::helpers::block_on_large_stack(
    "inv_docmeta_gql10_workspace_admin_updates_settings_collaborator_cannot",
    || async {
      inv_docmeta_gql10_workspace_admin_updates_settings_collaborator_cannot_inner().await;
    },
  );
}

async fn inv_docmeta_gql10_workspace_admin_updates_settings_collaborator_cannot_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, _owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql10").await;
  let (workspace_admin_id, workspace_admin_session) =
    crate::helpers::seed_user(&pool, &auth_store, "docmeta-ws-admin-gql10").await;
  let (collaborator_id, collaborator_session) =
    crate::helpers::seed_user(&pool, &auth_store, "docmeta-collab-gql10").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  add_workspace_member(&pool, workspace_id, workspace_admin_id, "Admin").await;
  add_workspace_member(&pool, workspace_id, collaborator_id, "Collaborator").await;
  let schema_id = status_schema_id(&pool, "review").await;
  let default_status_id = status_id(&pool, "review", "draft").await;
  let type_id = document_type_id(&pool, "concept").await;
  let classification_id = attribute_value_id(&pool, "classification", "internal").await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let admin_body = crate::helpers::gql(
    &app,
    workspace_admin_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceDocumentSettingsInput!) { updateWorkspaceDocumentSettings(workspaceId: $workspaceId, input: $input) { workspaceId statusSchemaId defaultStatusId defaultClassificationId updatedBy } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "input": {
          "statusSchemaId": schema_id.to_string(),
          "defaultStatusId": default_status_id.to_string(),
          "defaultClassificationId": classification_id.to_string()
        }
      }
    }),
  )
  .await;
  assert!(
    admin_body.get("errors").is_none(),
    "workspace admin must update settings: {admin_body}"
  );
  assert_eq!(
    admin_body
      .pointer("/data/updateWorkspaceDocumentSettings/statusSchemaId")
      .and_then(Value::as_str),
    Some(schema_id.to_string().as_str())
  );
  assert_eq!(
    admin_body
      .pointer("/data/updateWorkspaceDocumentSettings/defaultStatusId")
      .and_then(Value::as_str),
    Some(default_status_id.to_string().as_str())
  );
  assert_eq!(
    admin_body
      .pointer("/data/updateWorkspaceDocumentSettings/defaultClassificationId")
      .and_then(Value::as_str),
    Some(classification_id.to_string().as_str())
  );
  assert_eq!(
    admin_body
      .pointer("/data/updateWorkspaceDocumentSettings/updatedBy")
      .and_then(Value::as_str),
    Some(workspace_admin_id.to_string().as_str()),
    "workspace settings mutations must stamp the real actor for downstream materialization"
  );
  let rematerialized_doc: (Option<Uuid>, String, Option<Uuid>, String, Option<Uuid>) =
    sqlx::query_as("SELECT status_id, status_source, classification_id, classification_source, metadata_updated_by FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read doc after workspace settings update");
  assert_eq!(
    rematerialized_doc,
    (
      Some(default_status_id),
      "workspace".to_string(),
      Some(classification_id),
      "workspace".to_string(),
      Some(workspace_admin_id)
    ),
    "workspace settings update must rematerialize inherited document metadata immediately"
  );

  let partial_body = crate::helpers::gql(
    &app,
    workspace_admin_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceDocumentSettingsInput!) { updateWorkspaceDocumentSettings(workspaceId: $workspaceId, input: $input) { workspaceId statusSchemaId defaultStatusId defaultDocumentTypeId defaultClassificationId } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "input": {
          "defaultDocumentTypeId": type_id.to_string()
        }
      }
    }),
  )
  .await;
  assert!(
    partial_body.get("errors").is_none(),
    "partial workspace settings update must not require resending every default: {partial_body}"
  );
  assert_eq!(
    partial_body
      .pointer("/data/updateWorkspaceDocumentSettings/statusSchemaId")
      .and_then(Value::as_str),
    Some(schema_id.to_string().as_str()),
    "omitted statusSchemaId must preserve the current server-side setting"
  );
  assert_eq!(
    partial_body
      .pointer("/data/updateWorkspaceDocumentSettings/defaultStatusId")
      .and_then(Value::as_str),
    Some(default_status_id.to_string().as_str()),
    "omitted defaultStatusId must preserve the current server-side setting"
  );
  assert_eq!(
    partial_body
      .pointer("/data/updateWorkspaceDocumentSettings/defaultDocumentTypeId")
      .and_then(Value::as_str),
    Some(type_id.to_string().as_str()),
    "typed patch field must be applied without resending all defaults"
  );
  assert_eq!(
    partial_body
      .pointer("/data/updateWorkspaceDocumentSettings/defaultClassificationId")
      .and_then(Value::as_str),
    Some(classification_id.to_string().as_str()),
    "omitted defaultClassificationId must not be interpreted as reset-to-default"
  );

  let collaborator_body = crate::helpers::gql(
    &app,
    collaborator_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $input: UpdateWorkspaceDocumentSettingsInput!) { updateWorkspaceDocumentSettings(workspaceId: $workspaceId, input: $input) { workspaceId statusSchemaId } }",
      "variables": { "workspaceId": workspace_id.to_string(), "input": { "statusSchemaId": schema_id.to_string() } }
    }),
  )
  .await;
  assert!(
    collaborator_body.get("errors").is_some(),
    "collaborator must not update workspace document settings: {collaborator_body}"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id, workspace_admin_id, collaborator_id]).await;
}

#[test]
fn inv_docmeta_gql10b_workspace_settings_inherit_organization_defaults_without_override_row() {
  crate::helpers::block_on_large_stack(
    "inv_docmeta_gql10b_workspace_settings_inherit_organization_defaults_without_override_row",
    || async {
      inv_docmeta_gql10b_workspace_settings_inherit_organization_defaults_without_override_row_inner().await;
    },
  );
}

async fn inv_docmeta_gql10b_workspace_settings_inherit_organization_defaults_without_override_row_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql10b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;

  let org_defaults: (Option<Uuid>, Option<Uuid>, Option<Uuid>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
    "SELECT status_schema_id, default_status_id, default_document_type_id, default_classification_id, default_retention_policy_id \
     FROM organization_document_settings \
     WHERE organization_id = document_metadata_effective_organization_id($1)",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("effective organization document defaults");
  assert!(
    org_defaults.0.is_some()
      && org_defaults.1.is_some()
      && org_defaults.2.is_some()
      && org_defaults.3.is_some()
      && org_defaults.4.is_some(),
    "baseline profile must provide effective organization defaults for the API gate"
  );

  let explicit_rows_before: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM document_workspace_settings WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("workspace settings row count before");
  assert_eq!(
    explicit_rows_before, 0,
    "test workspace must start without an explicit workspace settings override row"
  );

  let inherited_body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!) { workspaceDocumentSettings(workspaceId: $workspaceId) { workspaceId statusSchemaId defaultStatusId defaultDocumentTypeId defaultClassificationId defaultRetentionPolicyId } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    inherited_body.get("errors").is_none(),
    "owner must read inherited workspace document settings without client write-back: {inherited_body}"
  );
  assert_eq!(
    inherited_body
      .pointer("/data/workspaceDocumentSettings/statusSchemaId")
      .and_then(Value::as_str),
    org_defaults.0.map(|id| id.to_string()).as_deref()
  );
  assert_eq!(
    inherited_body
      .pointer("/data/workspaceDocumentSettings/defaultStatusId")
      .and_then(Value::as_str),
    org_defaults.1.map(|id| id.to_string()).as_deref()
  );
  assert_eq!(
    inherited_body
      .pointer("/data/workspaceDocumentSettings/defaultDocumentTypeId")
      .and_then(Value::as_str),
    org_defaults.2.map(|id| id.to_string()).as_deref()
  );
  assert_eq!(
    inherited_body
      .pointer("/data/workspaceDocumentSettings/defaultClassificationId")
      .and_then(Value::as_str),
    org_defaults.3.map(|id| id.to_string()).as_deref()
  );
  assert_eq!(
    inherited_body
      .pointer("/data/workspaceDocumentSettings/defaultRetentionPolicyId")
      .and_then(Value::as_str),
    org_defaults.4.map(|id| id.to_string()).as_deref()
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[test]
fn inv_docmeta_gql11_workspace_member_reads_selectable_version_policies() {
  crate::helpers::block_on_large_stack(
    "inv_docmeta_gql11_workspace_member_reads_selectable_version_policies",
    || async {
      inv_docmeta_gql11_workspace_member_reads_selectable_version_policies_inner().await;
    },
  );
}

async fn inv_docmeta_gql11_workspace_member_reads_selectable_version_policies_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql11").await;
  let (outsider_id, outsider_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-outsider-gql11").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;

  let owner_body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentVersionPolicies(workspaceId: $workspaceId) { id scope workspaceId name isDefault enabledByDefault schemePreset autoVersionOn retentionCount } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    owner_body.get("errors").is_none(),
    "workspace member must read selectable version policies: {owner_body}"
  );
  let policies = owner_body
    .pointer("/data/documentVersionPolicies")
    .and_then(Value::as_array)
    .expect("documentVersionPolicies array");
  assert!(
    policies
      .iter()
      .any(|policy| policy.get("scope").and_then(Value::as_str) == Some("global")),
    "workspace policy list should expose global defaults: {owner_body}"
  );

  let outsider_body = crate::helpers::gql(
    &app,
    outsider_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentVersionPolicies(workspaceId: $workspaceId) { id } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    outsider_body.get("errors").is_some(),
    "non-member must not read workspace-scoped version policies: {outsider_body}"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id, outsider_id]).await;
}

#[test]
fn inv_docmeta_gql12_global_admin_reads_runtime_overview() {
  crate::helpers::block_on_large_stack("inv_docmeta_gql12_global_admin_reads_runtime_overview", || async {
    inv_docmeta_gql12_global_admin_reads_runtime_overview_inner().await;
  });
}

async fn inv_docmeta_gql12_global_admin_reads_runtime_overview_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (admin_id, admin_session) = crate::helpers::seed_admin(&pool, &auth_store).await;

  let body = crate::helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query Q { admin { documentRuntimeOverview { totalDocuments byStatus { key label count } byDocumentType { key label count } byClassification { key label count } byReviewDue { key label count } byVersionState { key label count } } } }"
    }),
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "global admin must read runtime overview: {body}"
  );
  assert!(
    body
      .pointer("/data/admin/documentRuntimeOverview/totalDocuments")
      .and_then(Value::as_i64)
      .is_some(),
    "overview exposes total document count: {body}"
  );
  for pointer in [
    "/data/admin/documentRuntimeOverview/byStatus",
    "/data/admin/documentRuntimeOverview/byDocumentType",
    "/data/admin/documentRuntimeOverview/byClassification",
    "/data/admin/documentRuntimeOverview/byReviewDue",
    "/data/admin/documentRuntimeOverview/byVersionState",
  ] {
    assert!(
      body.pointer(pointer).and_then(Value::as_array).is_some(),
      "{pointer} must be an array: {body}"
    );
  }

  crate::helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[test]
fn inv_docmeta_gql13_non_admin_cannot_read_runtime_overview() {
  crate::helpers::block_on_large_stack("inv_docmeta_gql13_non_admin_cannot_read_runtime_overview", || async {
    inv_docmeta_gql13_non_admin_cannot_read_runtime_overview_inner().await;
  });
}

async fn inv_docmeta_gql13_non_admin_cannot_read_runtime_overview_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (user_id, session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-non-admin-gql12").await;

  let body = crate::helpers::gql(
    &app,
    session,
    json!({
      "query": "query Q { admin { documentRuntimeOverview { totalDocuments } } }"
    }),
  )
  .await;

  assert!(
    body.get("errors").is_some(),
    "non-admin must not read runtime overview: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[user_id]).await;
}

#[test]
fn inv_docmeta_gql14_workspace_member_reads_document_metadata_index() {
  crate::helpers::block_on_large_stack(
    "inv_docmeta_gql14_workspace_member_reads_document_metadata_index",
    || async {
      inv_docmeta_gql14_workspace_member_reads_document_metadata_index_inner().await;
    },
  );
}

async fn inv_docmeta_gql14_workspace_member_reads_document_metadata_index_inner() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql14").await;
  let (outsider_id, outsider_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-outsider-gql14").await;
  let (limited_id, limited_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-limited-gql14").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'External', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(limited_id)
  .execute(&pool)
  .await
  .expect("insert limited workspace member");
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Reader')")
    .bind(limited_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("grant one readable document");
  let nano_doc_id = Uuid::new_v4();
  let nano_external_id = format!("MetadataNano{}", Uuid::new_v4().simple());
  let collision_external_id = Uuid::new_v4();
  let collision_decoy_id = collision_external_id;
  let collision_doc_id = Uuid::new_v4();
  let deleted_doc_id = Uuid::new_v4();
  for (id, external_id, title, deleted) in [
    (nano_doc_id, nano_external_id.clone(), "Nano metadata row", false),
    (
      collision_decoy_id,
      format!("metadata-decoy-{}", Uuid::new_v4().simple()),
      "Collision decoy metadata row",
      false,
    ),
    (
      collision_doc_id,
      collision_external_id.to_string(),
      "UUID-shaped external metadata row",
      false,
    ),
    (
      deleted_doc_id,
      format!("metadata-deleted-{}", Uuid::new_v4().simple()),
      "Deleted metadata row",
      true,
    ),
  ] {
    sqlx::query(
      "INSERT INTO docs (id, external_id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by, deleted_at) \
       VALUES ($1, $2, $3, $4, 'viewer', FALSE, $5, $5, CASE WHEN $6 THEN now() ELSE NULL END)",
    )
    .bind(id)
    .bind(external_id)
    .bind(workspace_id)
    .bind(title)
    .bind(owner_id)
    .bind(deleted)
    .execute(&pool)
    .await
    .expect("insert metadata identity control");
  }
  for content_doc_id in [doc_id, nano_doc_id, collision_doc_id] {
    sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 1)")
      .bind(content_doc_id)
      .bind(workspace_id)
      .bind(vec![1_u8])
      .execute(&pool)
      .await
      .expect("mark metadata index fixture as content-bearing");
  }
  let type_id = document_type_id(&pool, "concept").await;
  let classification_id = attribute_value_id(&pool, "classification", "internal").await;

  let active_tag = Uuid::new_v4();
  let archived_tag = Uuid::new_v4();
  for (tag_id, slug, archived) in [
    (active_tag, "index-active", false),
    (archived_tag, "index-archived", true),
  ] {
    sqlx::query("INSERT INTO workspace_tags (id, workspace_id, name, slug, color_role, archived_at) VALUES ($1,$2,$3,$3,'tag.blue',CASE WHEN $4 THEN now() ELSE NULL END)")
      .bind(tag_id).bind(workspace_id).bind(slug).bind(archived).execute(&pool).await.expect("seed indexed labels");
  }
  for (position, tag_id) in [archived_tag, active_tag].into_iter().enumerate() {
    sqlx::query(
      "INSERT INTO workspace_tag_document_assignments (workspace_id, doc_id, tag_id, position) VALUES ($1,$2,$3,$4)",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(tag_id)
    .bind(position as i32)
    .execute(&pool)
    .await
    .expect("seed ordered indexed assignments");
  }

  let set_body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { fields { key reference { id } timestampValue } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "documentTypeId": type_id.to_string(),
          "classificationId": classification_id.to_string(),
          "reviewDueAt": "2026-07-01T00:00:00Z",
          "journalDate": "2026-07-02",
          "templateState": "managed",
          "templateOrigin": "custom",
          "primaryMode": "edgeless",
          "pageWidth": "fullWidth",
          "edgelessColorTheme": "dark",
          "integrationType": "readwise"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    set_body.get("errors").is_none(),
    "setup patch must persist indexed canonical fields: {set_body}"
  );

  let cached_index = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId templateCategory templateTags } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(cached_index.get("errors").is_none(), "warm the index: {cached_index}");
  let classified = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { docId } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": { "templateCategory": "building-blocks", "templateTags": ["projects"] }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    classified.get("errors").is_none(),
    "classify the existing source: {classified}"
  );

  let owner_body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId externalId createdBy updatedBy journalDate isTemplate templateState templateOrigin templateCategory templateTags primaryMode pageWidth edgelessColorTheme integrationType canPublish statusId documentTypeId classificationId reviewDueAt currentVersionId dirtySinceCurrentVersion validUntil tagIds } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    owner_body.get("errors").is_none(),
    "workspace member must read document metadata index: {owner_body}"
  );
  let rows = owner_body
    .pointer("/data/documentMetadataIndex")
    .and_then(Value::as_array)
    .expect("documentMetadataIndex rows");
  let row = rows
    .iter()
    .find(|row| row.get("docId").and_then(Value::as_str) == Some(doc_id.to_string().as_str()))
    .unwrap_or_else(|| panic!("index must include created document: {owner_body}"));
  assert_eq!(
    row.get("externalId").and_then(Value::as_str),
    Some(doc_id.to_string().as_str()),
    "UUID-default documents must expose the unchanged browser key: {owner_body}"
  );
  assert!(
    row.get("statusId").and_then(Value::as_str).is_some(),
    "index must expose effective status fallback: {owner_body}"
  );
  assert_eq!(
    row.get("documentTypeId").and_then(Value::as_str),
    Some(type_id.to_string().as_str())
  );
  assert_eq!(
    row.get("classificationId").and_then(Value::as_str),
    Some(classification_id.to_string().as_str())
  );
  assert!(
    row
      .get("reviewDueAt")
      .and_then(Value::as_str)
      .is_some_and(|value| value.starts_with("2026-07-01T00:00:00")),
    "index must expose persisted review due date: {owner_body}"
  );
  assert_eq!(
    row.get("createdBy").and_then(Value::as_str),
    Some(owner_id.to_string().as_str())
  );
  assert_eq!(
    row.get("updatedBy").and_then(Value::as_str),
    Some(owner_id.to_string().as_str())
  );
  assert_eq!(row.get("journalDate").and_then(Value::as_str), Some("2026-07-02"));
  assert_eq!(row.get("isTemplate").and_then(Value::as_bool), Some(true));
  assert_eq!(row.get("templateState").and_then(Value::as_str), Some("managed"));
  assert_eq!(row.get("templateOrigin").and_then(Value::as_str), Some("custom"));
  assert_eq!(
    row.get("templateCategory").and_then(Value::as_str),
    Some("building-blocks")
  );
  assert_eq!(row.get("templateTags"), Some(&json!(["projects"])));
  assert_eq!(row.get("primaryMode").and_then(Value::as_str), Some("edgeless"));
  assert_eq!(row.get("pageWidth").and_then(Value::as_str), Some("fullWidth"));
  assert_eq!(row.get("edgelessColorTheme").and_then(Value::as_str), Some("dark"));
  assert_eq!(row.get("integrationType").and_then(Value::as_str), Some("readwise"));
  assert_eq!(row.get("canPublish").and_then(Value::as_bool), Some(true));
  assert_eq!(
    row.get("tagIds"),
    Some(&json!([archived_tag.to_string(), active_tag.to_string()]))
  );
  let nano_row = rows
    .iter()
    .find(|row| row.get("docId").and_then(Value::as_str) == Some(nano_doc_id.to_string().as_str()))
    .unwrap_or_else(|| panic!("index must include NanoID document: {owner_body}"));
  assert_eq!(
    nano_row.get("externalId").and_then(Value::as_str),
    Some(nano_external_id.as_str()),
    "NanoID projection must not fall back to the internal UUID: {owner_body}"
  );
  assert_eq!(
    nano_row.get("tagIds"),
    Some(&json!([])),
    "untagged content must be confirmed empty"
  );
  let collision_row = rows
    .iter()
    .find(|row| row.get("docId").and_then(Value::as_str) == Some(collision_doc_id.to_string().as_str()))
    .unwrap_or_else(|| panic!("index must include UUID-shaped external-key document: {owner_body}"));
  assert_eq!(
    collision_row.get("externalId").and_then(Value::as_str),
    Some(collision_external_id.to_string().as_str()),
    "UUID-shaped external keys must remain bound to their own internal row: {owner_body}"
  );
  assert!(
    rows
      .iter()
      .all(|row| row.get("docId").and_then(Value::as_str) != Some(deleted_doc_id.to_string().as_str())),
    "deleted documents must not re-enter the operational metadata index: {owner_body}"
  );

  let outsider_body = crate::helpers::gql(
    &app,
    outsider_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId canPublish tagIds } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    outsider_body.get("errors").is_some(),
    "non-member must not read workspace document metadata index: {outsider_body}"
  );

  let limited_body = crate::helpers::gql(
    &app,
    limited_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId canPublish tagIds } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  let limited_rows = limited_body
    .pointer("/data/documentMetadataIndex")
    .and_then(Value::as_array)
    .unwrap_or_else(|| panic!("limited member must receive an authorized index: {limited_body}"));
  assert_eq!(
    limited_rows,
    &[
      json!({ "docId": doc_id.to_string(), "canPublish": false, "tagIds": [archived_tag.to_string(), active_tag.to_string()] })
    ],
    "bulk Doc Read filtering must exclude every ungranted document: {limited_body}"
  );

  // Assignments are deliberately read outside the actor-independent metadata cache.
  sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE doc_id = $1 AND tag_id = $2")
    .bind(doc_id)
    .bind(archived_tag)
    .execute(&pool)
    .await
    .expect("change assignment while metadata index stays warm");
  let refreshed_body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId tagIds } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(
    refreshed_body.get("errors").is_none(),
    "warm label projection must succeed: {refreshed_body}"
  );
  let refreshed_row = refreshed_body
    .pointer("/data/documentMetadataIndex")
    .and_then(Value::as_array)
    .expect("refreshed index")
    .iter()
    .find(|row| row.get("docId").and_then(Value::as_str) == Some(doc_id.to_string().as_str()))
    .expect("refreshed document");
  assert_eq!(
    refreshed_row.get("tagIds"),
    Some(&json!([active_tag.to_string()])),
    "cached metadata must not retain old assignments"
  );

  sqlx::query("DELETE FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
    .bind(limited_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("revoke limited document access while the actor-independent index stays warm");
  let revoked_body = crate::helpers::gql(
    &app,
    limited_session,
    json!({
      "query": "query Q($workspaceId: ID!) { documentMetadataIndex(workspaceId: $workspaceId) { docId canPublish tagIds } }",
      "variables": { "workspaceId": workspace_id.to_string() }
    }),
  )
  .await;
  let revoked_rows = revoked_body
    .pointer("/data/documentMetadataIndex")
    .and_then(Value::as_array)
    .unwrap_or_else(|| panic!("limited member must receive an authorized empty index: {revoked_body}"));
  assert!(
    revoked_rows.is_empty(),
    "authorization must be rechecked after a shared index-cache hit: {revoked_body}"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id, outsider_id, limited_id]).await;
}
