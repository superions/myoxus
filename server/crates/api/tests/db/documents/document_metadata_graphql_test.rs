// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for the native document metadata GraphQL contract.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Native metadata rearm must reach the actual Run/snapshot storage consumer.
/// Ledger/schema checks alone missed the Task-only generated generation fence.
#[test]
fn metadata_deadline_rearms_one_native_review_without_duplicate_admission() {
  crate::helpers::block_on_large_stack("metadata-review-contract", || async {
    use futures_util::FutureExt;
    use myoxus_application::{
      doc::document_fragment_from_markdown, document_metadata::review::ReviewPlanningCapabilities,
      workspace_automation::runtime::WorkspaceAutomationRuntime,
    };
    use myoxus_infrastructure::{
      document_metadata::PgDocumentMetadataRepository, scheduling::PgSchedulingRepository,
      workflow_runtime::GlirulusWorkspaceAutomationRuntime,
    };
    use std::{panic::AssertUnwindSafe, sync::Arc};
    let (_, pool, auth, state) = crate::helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (actor, session) = crate::helpers::seed_user(&pool, &auth, "metadata-review-contract").await;
    let workspace = crate::helpers::create_workspace(&pool, actor).await;
    let mut runs = Vec::new();
    let result=AssertUnwindSafe(async{
      state.workspace().seed_root_doc(workspace,actor,yjs::create_initial_workspace_doc("Review contract")).await.unwrap();
      let created=state.doc().create_page_lifecycle(workspace,actor,Some("Safety review".into()),Some(document_fragment_from_markdown("Inspect the pressure-isolation interlock.").unwrap())).await.unwrap();
      let document=created.document.id;
      let metadata=state.document_metadata_service().unwrap().with_review_planning(ReviewPlanningCapabilities{
        repo:Arc::new(PgDocumentMetadataRepository::new(pool.clone())),packages:state.assistant_packages().unwrap(),
        automations:state.workspace_automation_service().unwrap(),auth:Arc::new(state.auth().clone()),defaults:state.user_preference_defaults().await});
      let app=myoxus_api::build_router_for_integration_tests(state.clone().with_document_metadata_service(metadata.clone()));
      let now=Utc::now();
      let source=now+Duration::days(5);
      let first=metadata.review_planning(document,workspace).await.unwrap();
      let patch=|revision,values:Value|json!({"query":"mutation($ws:ID!,$doc:ID!,$input:SetDocumentMetadataInput!){setDocumentMetadata(workspaceId:$ws,docId:$doc,input:$input){metadata{metadataRevision}}}","variables":{"ws":workspace,"doc":created.document.external_id,"input":{
        "expectedMetadataRevision":revision,"reviewDueAt":values["reviewDueAt"],"validUntil":values["validUntil"],"responsibleUserId":actor}}});
      let response=crate::helpers::gql_with_headers(&app,session,patch(first.metadata_revision,json!({"reviewDueAt":source,"validUntil":source+Duration::days(1)})),&[("x-myoxus-client-format","myoxus-native")]).await;
      assert!(response.get("errors").is_none(),"{response}");
      let revision=response["data"]["setDocumentMetadata"]["metadata"]["metadataRevision"].as_i64().unwrap();
      metadata.configure_review_planning(document,workspace,actor,revision,true).await.unwrap();
      // Edit both sources before admission; only the effective latest minimum
      // may own a Run. No fabricated accepted JSON or direct Run INSERT.
      let current=metadata.review_planning(document,workspace).await.unwrap();
      let earlier=source-Duration::days(1);
      let response=crate::helpers::gql_with_headers(&app,session,patch(current.metadata_revision,json!({"reviewDueAt":source+Duration::days(2),"validUntil":earlier})),&[("x-myoxus-client-format","myoxus-native")]).await;
      assert!(response.get("errors").is_none(),"{response}");
      let current=metadata.review_planning(document,workspace).await.unwrap();
      assert_eq!(current.source_deadline.unwrap().timestamp_micros(),earlier.timestamp_micros());
      let runtime=Arc::new(GlirulusWorkspaceAutomationRuntime::new(pool.clone(),state.workspace_automation_service().unwrap().native_executor()));
      runtime.readiness().await.unwrap();
      let scheduler=PgSchedulingRepository::new(pool.clone(),runtime).with_document_review_source(Arc::new(metadata.clone()));
      let slot=myoxus_domain::scheduling::document_review_occurrence_id(document,current.source_deadline.unwrap());
      let run=Uuid::new_v5(&slot,b"run");runs.push(run);
      let (a,b)=tokio::join!(scheduler.dispatch_due(now,50),scheduler.dispatch_due(now,50));
      let _=(a.unwrap(),b.unwrap());
      let actual:(i64,i64,i64,Option<i64>)=sqlx::query_as("SELECT (SELECT count(*) FROM scheduling_occurrences WHERE schedule_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE id=$2),(SELECT count(*) FROM sayiir_workflow_snapshots WHERE instance_id=$3),(SELECT scheduling_generation FROM workspace_automation_runs WHERE id=$2)")
        .bind(myoxus_domain::scheduling::document_review_schedule_id(document)).bind(run).bind(run.to_string()).fetch_one(&pool).await.unwrap();
      assert_eq!((actual.0,actual.1,actual.2),(1,1,1),"metadata must reach one durable native Run/snapshot even with concurrent dispatch");
      assert!(actual.3.is_some_and(|generation|generation>0),"automatic Review must pass the generated scheduling fence");
      let accepted=metadata.review_planning(document,workspace).await.unwrap();
      assert_eq!(accepted.run_id,Some(run));
      metadata.configure_review_planning(document,workspace,actor,accepted.metadata_revision,false).await.unwrap();
      let disabled=metadata.review_planning(document,workspace).await.unwrap();
      metadata.configure_review_planning(document,workspace,actor,disabled.metadata_revision,true).await.unwrap();
      scheduler.dispatch_due(now+Duration::seconds(31),50).await.unwrap();
      let restored=metadata.review_planning(document,workspace).await.unwrap();
      assert_eq!((restored.run_id,restored.blocked_reason.as_deref()),(Some(run),Some("cycleAlreadyAccepted")));
      let count:i64=sqlx::query_scalar("SELECT count(*) FROM scheduling_occurrences WHERE schedule_id=$1")
        .bind(myoxus_domain::scheduling::document_review_schedule_id(document)).fetch_one(&pool).await.unwrap();
      assert_eq!(count,1,"reconfirmation cannot create another native Review");
    }).catch_unwind().await;
    for run in &runs {
      sqlx::query("DELETE FROM sayiir_workflow_snapshots WHERE instance_id=$1")
        .bind(run.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    crate::helpers::cleanup_workspaces(&pool, &[workspace]).await;
    crate::helpers::cleanup_users(&pool, &[actor]).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic)
    }
  });
}

async fn reference_id(pool: &PgPool, table: &str, key: &str) -> Uuid {
  let sql = format!("SELECT id FROM {table} WHERE key = $1");
  sqlx::query_scalar(&sql)
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("reference id")
}

async fn set_effective_org_field_enabled(
  pool: &PgPool,
  workspace_id: Uuid,
  actor_id: Uuid,
  field_key: &str,
  enabled: bool,
) {
  let org_id: Uuid = sqlx::query_scalar("SELECT document_metadata_effective_organization_id($1)")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .expect("effective organization id");
  sqlx::query(
    "INSERT INTO organization_document_metadata_policy \
       (organization_id, field_key, enabled, visible_in_properties, visible_in_header, updated_by) \
     VALUES ($1, $2, $3, true, true, $4) \
     ON CONFLICT (organization_id, field_key) DO UPDATE \
       SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()",
  )
  .bind(org_id)
  .bind(field_key)
  .bind(enabled)
  .bind(actor_id)
  .execute(pool)
  .await
  .expect("set organization field policy");
}

fn error_code(body: &Value) -> Option<&str> {
  body.pointer("/errors/0/extensions/code").and_then(Value::as_str)
}

#[tokio::test]
async fn inv_docmeta_gql01_native_projection_requires_native_client_header() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql01").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId, requestedProjectionMode: MYOXUS_NATIVE) { docId } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;

  assert_eq!(
    error_code(&body),
    Some("DOCUMENT_METADATA_PROJECTION_NOT_ALLOWED"),
    "native projection must be rejected for legacy-safe clients: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql01b_native_validation_requires_native_client_header() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql01b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let body = crate::helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadataValidation(workspaceId: $workspaceId, docId: $docId, action: export_pdf) { valid } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;

  assert_eq!(
    error_code(&body),
    Some("DOCUMENT_METADATA_PROJECTION_NOT_ALLOWED"),
    "native validation must not be exposed through the legacy-safe client boundary: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql02_native_client_reads_canonical_docs_projection() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql02").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query("UPDATE docs SET dirty_since_current_version = true, metadata_updated_by = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed dirty native version state");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { docId workspaceId projectionMode projectionVersion metadataRevision fields { key source reference { key label } textValue timestampValue userId } audience { source value { key label } } policy { locks { key inheritanceMode editable reason } } legacy } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(body.get("errors").is_none(), "native client must read metadata: {body}");
  assert_eq!(
    body.pointer("/data/documentMetadata/docId").and_then(Value::as_str),
    Some(doc_id.to_string().as_str())
  );
  assert_eq!(
    body
      .pointer("/data/documentMetadata/projectionMode")
      .and_then(Value::as_str),
    Some("MYOXUS_NATIVE")
  );
  assert!(
    body
      .pointer("/data/documentMetadata/projectionVersion")
      .and_then(Value::as_str)
      .is_some_and(|value| value.starts_with("contract-v3:doc:")),
    "native projection must expose a metadata freshness version: {body}"
  );
  assert!(
    body
      .pointer("/data/documentMetadata/fields")
      .and_then(Value::as_array)
      .map(|items| items.iter().any(|item| item["key"] == "documentType"))
      .unwrap_or(false),
    "projection must expose canonical attribute entries: {body}"
  );
  let fields = body
    .pointer("/data/documentMetadata/fields")
    .and_then(Value::as_array)
    .expect("native fields");
  assert!(
    fields
      .iter()
      .any(|item| item["key"] == "status" && item["reference"]["label"].as_str().is_some()),
    "native projection must expose docs.status_id as a typed canonical attribute: {body}"
  );
  for (key, reference_key, source) in [
    ("documentType", "documentation", "ORGANIZATION"),
    ("classification", "public", "ORGANIZATION"),
    ("retentionPolicy", "standard", "ORGANIZATION"),
    ("language", "en", "ORGANIZATION"),
  ] {
    assert!(
      fields
        .iter()
        .any(|item| { item["key"] == key && item["reference"]["key"] == reference_key && item["source"] == source }),
      "fresh docs must expose materialized default {key}={reference_key} from {source}: {body}"
    );
  }
  assert!(
    fields.iter().any(|item| item["key"] == "responsible"
      && item["userId"] == owner_id.to_string()
      && item["source"] == "FALLBACK"),
    "fresh docs must expose responsible fallback as a native user id: {body}"
  );
  assert!(
    fields
      .iter()
      .any(|item| item["key"] == "version" && item["textValue"] == "dirty"),
    "native projection must expose docs dirty version state without reading document_attribute_state: {body}"
  );
  let audience = body
    .pointer("/data/documentMetadata/audience")
    .and_then(Value::as_array)
    .expect("native audience");
  assert!(
    audience
      .iter()
      .any(|item| item["value"]["key"] == "internal" && item["source"] == "ORGANIZATION"),
    "fresh docs must expose materialized default audience from organization settings: {body}"
  );
  let locks = body
    .pointer("/data/documentMetadata/policy/locks")
    .and_then(Value::as_array)
    .expect("policy locks");
  assert!(
    locks.iter().any(|item| {
      item["key"] == "journalDate" && item["inheritanceMode"] == "SYSTEM_READONLY" && item["editable"] == false
    }),
    "native projection must expose server-side field locks: {body}"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql02b_native_validation_reads_canonical_docs_policy_state() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql02b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let expired_at = Utc::now() - Duration::days(1);
  sqlx::query("UPDATE docs SET valid_until = $2, metadata_updated_by = $3 WHERE id = $1")
    .bind(doc_id)
    .bind(expired_at)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed expired canonical validity date");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadataValidation(workspaceId: $workspaceId, docId: $docId, action: export_pdf) { valid blockedActions missingRequiredMetadataFields errors { code key severity blockedActions } warnings { code key severity blockedActions } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "native metadata validation query failed: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/documentMetadataValidation/valid")
      .and_then(Value::as_bool),
    Some(false),
    "expired canonical docs.valid_until must invalidate export validation: {body}"
  );
  let blocked_actions = body
    .pointer("/data/documentMetadataValidation/blockedActions")
    .and_then(Value::as_array)
    .expect("blocked actions");
  assert!(
    blocked_actions.iter().any(|value| value == "export_pdf"),
    "export_pdf must be blocked by canonical validity state: {body}"
  );
  let errors = body
    .pointer("/data/documentMetadataValidation/errors")
    .and_then(Value::as_array)
    .expect("validation errors");
  assert!(
    errors.iter().any(|error| {
      error["code"] == "DOCUMENT_VALIDITY_EXPIRED" && error["key"] == "validUntil" && error["severity"] == "error"
    }),
    "native validation must expose the policy issue from canonical docs.valid_until: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/documentMetadataValidation/warnings")
      .and_then(Value::as_array)
      .map(Vec::len),
    Some(0),
    "export-specific expired validity is an error, not a warning: {body}"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql03_set_metadata_persists_canonical_head_and_audience() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql03").await;
  let (previous_updater_id, _) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-prev-updater-gql03").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  set_effective_org_field_enabled(&pool, workspace_id, owner_id, "documentNumber", true).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query("UPDATE docs SET updated_by = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(previous_updater_id)
    .execute(&pool)
    .await
    .expect("seed distinct content updater");
  let before_updated_at: DateTime<Utc> = sqlx::query_scalar("SELECT updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read content updated_at before metadata mutation");
  let before_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read projection revision before metadata mutation");
  let document_type_id = reference_id(&pool, "document_type_definition", "concept").await;
  let classification_id = reference_id(&pool, "document_classification_definition", "internal").await;
  let language_id = reference_id(&pool, "language_definition", "de").await;
  let internal_audience_id = reference_id(&pool, "document_audience_definition", "internal").await;
  let customer_audience_id = reference_id(&pool, "document_audience_definition", "customer").await;

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision metadataUpdatedBy fields { key source reference { key label } textValue } audience { source value { key } } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "documentTypeId": document_type_id.to_string(),
          "classificationId": classification_id.to_string(),
          "languageId": language_id.to_string(),
          "documentNumber": "DOC-META-42",
          "audienceIds": [internal_audience_id.to_string(), customer_audience_id.to_string()]
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(body.get("errors").is_none(), "setDocumentMetadata failed: {body}");
  let fields = body
    .pointer("/data/setDocumentMetadata/metadata/fields")
    .and_then(Value::as_array)
    .expect("fields");
  assert!(
    fields
      .iter()
      .any(|attr| attr["key"] == "documentNumber" && attr["textValue"] == "DOC-META-42"),
    "documentNumber must be read from docs.document_number: {body}"
  );
  assert!(
    fields
      .iter()
      .any(|attr| attr["key"] == "classification" && attr["reference"]["key"] == "internal"),
    "classification must be read from canonical classification reference: {body}"
  );
  let audience = body
    .pointer("/data/setDocumentMetadata/metadata/audience")
    .and_then(Value::as_array)
    .expect("audience");
  assert_eq!(audience.len(), 2, "audience is many-valued and canonical: {body}");
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/metadataRevision")
      .and_then(Value::as_i64),
    Some(before_revision + 1),
    "one atomic metadata mutation must produce exactly one metadata revision even when head fields and audience change together: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/metadataUpdatedBy")
      .and_then(Value::as_str),
    Some(owner_id.to_string().as_str())
  );
  let (updated_by, after_updated_at): (Option<Uuid>, DateTime<Utc>) =
    sqlx::query_as("SELECT updated_by, updated_at FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read content update markers");
  assert_eq!(
    updated_by,
    Some(previous_updater_id),
    "metadata mutation must not overwrite docs.updated_by"
  );
  assert_eq!(
    after_updated_at, before_updated_at,
    "metadata mutation must not touch docs.updated_at; metadata_revision is the freshness marker"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id, previous_updater_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql04_expected_revision_conflict_blocks_write() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql04").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  set_effective_org_field_enabled(&pool, workspace_id, owner_id, "documentNumber", true).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let classification_id = reference_id(&pool, "document_classification_definition", "internal").await;

  sqlx::query("UPDATE docs SET document_number = 'EXISTING', metadata_updated_by = $2 WHERE id = $1")
    .bind(doc_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed metadata revision");
  let current_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read seeded revision");
  let initial_classification_id: Option<Uuid> = sqlx::query_scalar("SELECT classification_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read initial classification");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "expectedMetadataRevision": current_revision - 1,
          "classificationId": classification_id.to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert_eq!(
    error_code(&body),
    Some("DOCUMENT_METADATA_REVISION_CONFLICT"),
    "stale expectedMetadataRevision must reject atomically: {body}"
  );
  let persisted: (i64, Option<Uuid>) =
    sqlx::query_as("SELECT metadata_revision, classification_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read metadata after rejected patch");
  assert_eq!(
    persisted.0, current_revision,
    "conflict must not bump metadata revision"
  );
  assert_eq!(
    persisted.1, initial_classification_id,
    "conflict must not overwrite the materialized default classification"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05_invalid_reference_reports_reference_error() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let missing_reference_id = Uuid::new_v4();
  let initial_classification_id: Option<Uuid> = sqlx::query_scalar("SELECT classification_id FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read initial classification");
  let before_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read revision before rejected reference");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "classificationId": missing_reference_id.to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert_eq!(
    error_code(&body),
    Some("DOCUMENT_METADATA_REFERENCE_NOT_FOUND"),
    "missing reference ids must not be reported as revision conflicts: {body}"
  );
  let persisted: (i64, Option<Uuid>) =
    sqlx::query_as("SELECT metadata_revision, classification_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read metadata after rejected reference");
  assert_eq!(
    persisted.0, before_revision,
    "invalid reference must not bump metadata revision"
  );
  assert_eq!(
    persisted.1, initial_classification_id,
    "invalid reference must not overwrite the materialized default classification"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05b_journal_calendar_subsystem_is_writable_with_doc_update_permission() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05b").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision journal { journalDate } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "journalDate": "2026-05-25"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "journal calendar subsystem metadata write failed: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/journal/journalDate")
      .and_then(Value::as_str),
    Some("2026-05-25"),
    "journalDate must be returned through the native projection after a subsystem write: {body}"
  );
  let persisted: Option<String> = sqlx::query_scalar("SELECT journal_date::text FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read persisted journal date");
  assert_eq!(
    persisted.as_deref(),
    Some("2026-05-25"),
    "journal calendar subsystem writes must persist docs.journal_date"
  );
  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05c_system_facts_are_not_writable_via_metadata_input() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05c").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let before = sqlx::query("SELECT created_at, created_by, updated_at, updated_by FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read system facts before rejected patch");
  let before_created_at: DateTime<Utc> = before.get("created_at");
  let before_created_by: Option<Uuid> = before.get("created_by");
  let before_updated_at: DateTime<Utc> = before.get("updated_at");
  let before_updated_by: Option<Uuid> = before.get("updated_by");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "createdAt": "2001-01-01T00:00:00Z",
          "createdBy": Uuid::new_v4().to_string(),
          "updatedAt": "2001-01-02T00:00:00Z",
          "updatedBy": Uuid::new_v4().to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_some(),
    "system fields must not be accepted by SetDocumentMetadataInput: {body}"
  );
  assert!(
    body["errors"][0]["message"].as_str().is_some_and(|message| {
      ["createdAt", "createdBy", "updatedAt", "updatedBy"]
        .iter()
        .any(|field| message.contains(field))
    }),
    "GraphQL validation must reject unknown system input fields, got: {body}"
  );
  let after = sqlx::query("SELECT created_at, created_by, updated_at, updated_by FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read system facts after rejected patch");
  assert_eq!(after.get::<DateTime<Utc>, _>("created_at"), before_created_at);
  assert_eq!(after.get::<Option<Uuid>, _>("created_by"), before_created_by);
  assert_eq!(after.get::<DateTime<Utc>, _>("updated_at"), before_updated_at);
  assert_eq!(after.get::<Option<Uuid>, _>("updated_by"), before_updated_by);

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05d_field_policy_errors_are_specific_and_atomic() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05d").await;
  let (collaborator_id, collaborator_session) =
    crate::helpers::seed_user(&pool, &auth_store, "docmeta-collab-gql05d").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(collaborator_id)
  .execute(&pool)
  .await
  .expect("add collaborator");
  let initial_retention_policy_id: Option<Uuid> =
    sqlx::query_scalar("SELECT retention_policy_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read initial retention policy");
  let before_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read revision before rejected policy mutations");
  let retention_policy_id = reference_id(&pool, "document_retention_policy_definition", "short_lived").await;

  let locked = crate::helpers::gql_with_headers(
    &app,
    collaborator_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "retentionPolicyId": retention_policy_id.to_string(),
          "documentNumber": "SHOULD-NOT-PERSIST"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert_eq!(
    error_code(&locked),
    Some("DOCUMENT_METADATA_FIELD_LOCKED"),
    "workspace-admin-only metadata must reject collaborators before any partial write: {locked}"
  );
  let after_locked: (i64, Option<String>, Option<Uuid>) =
    sqlx::query_as("SELECT metadata_revision, document_number, retention_policy_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read after locked mutation");
  assert_eq!(
    after_locked.0, before_revision,
    "locked mutation must not bump metadata revision"
  );
  assert_eq!(after_locked.1, None, "locked mutation must not persist sibling fields");
  assert_eq!(
    after_locked.2, initial_retention_policy_id,
    "locked mutation must not persist the protected field"
  );

  set_effective_org_field_enabled(&pool, workspace_id, owner_id, "documentNumber", false).await;
  let disabled = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "documentNumber": "DISABLED-SHOULD-NOT-PERSIST"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert_eq!(
    error_code(&disabled),
    Some("DOCUMENT_METADATA_FIELD_DISABLED"),
    "organization-disabled metadata fields must use a distinct code: {disabled}"
  );
  let after_disabled: (i64, Option<String>) =
    sqlx::query_as("SELECT metadata_revision, document_number FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read after disabled mutation");
  assert_eq!(
    after_disabled.0, before_revision,
    "disabled mutation must not bump metadata revision"
  );
  assert_eq!(
    after_disabled.1, None,
    "disabled mutation must not persist the disabled field"
  );
  set_effective_org_field_enabled(&pool, workspace_id, owner_id, "documentNumber", true).await;

  crate::helpers::cleanup_users(&pool, &[owner_id, collaborator_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05e_permission_denied_uses_metadata_contract_code() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, _) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05e").await;
  let (outsider_id, outsider_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-outsider-gql05e").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  set_effective_org_field_enabled(&pool, workspace_id, owner_id, "documentNumber", true).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let before_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read revision before denied metadata mutation");

  let denied = crate::helpers::gql_with_headers(
    &app,
    outsider_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "documentNumber": "OUTSIDER-SHOULD-NOT-PERSIST"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert_eq!(
    error_code(&denied),
    Some("DOCUMENT_METADATA_PERMISSION_DENIED"),
    "native metadata resolvers must not leak generic ACTION_FORBIDDEN codes: {denied}"
  );
  let after_denied: (i64, Option<String>) =
    sqlx::query_as("SELECT metadata_revision, document_number FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read after denied mutation");
  assert_eq!(
    after_denied.0, before_revision,
    "denied mutation must not bump metadata revision"
  );
  assert_eq!(
    after_denied.1, None,
    "denied mutation must not persist document metadata"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id, outsider_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql05c_responsible_user_must_be_workspace_valid() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql05c").await;
  let (external_id, _) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-external-gql05c").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let before_revision: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read revision before invalid responsible mutation");

  let rejected = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "responsibleUserId": external_id.to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert_eq!(
    error_code(&rejected),
    Some("DOCUMENT_METADATA_RESPONSIBLE_INVALID"),
    "responsibleUserId must be an active user in the workspace/organization scope: {rejected}"
  );
  let rejected_state: (i64, Option<Uuid>) =
    sqlx::query_as("SELECT metadata_revision, responsible_user_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("read metadata after rejected responsible patch");
  assert_eq!(
    rejected_state.0, before_revision,
    "invalid responsible patch must not bump metadata revision"
  );
  assert_eq!(
    rejected_state.1,
    Some(owner_id),
    "invalid responsible patch must keep the materialized owner fallback"
  );

  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
     VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(external_id)
  .execute(&pool)
  .await
  .expect("add external user to workspace");

  let accepted = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { metadataRevision fields { key source userId } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "responsibleUserId": external_id.to_string()
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    accepted.get("errors").is_none(),
    "workspace-scoped responsibleUserId must be accepted: {accepted}"
  );
  let fields = accepted
    .pointer("/data/setDocumentMetadata/metadata/fields")
    .and_then(Value::as_array)
    .expect("fields after responsible patch");
  assert!(
    fields.iter().any(|item| item["key"] == "responsible"
      && item["userId"] == external_id.to_string()
      && item["source"] == "DOCUMENT"),
    "accepted responsible patch must persist as canonical document metadata: {accepted}"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
}

#[tokio::test]
async fn inv_docmeta_gql06_native_subsystem_fields_roundtrip_and_bump_freshness() {
  let (app, pool, auth_store) = crate::helpers::setup_app().await;
  let (owner_id, owner_session) = crate::helpers::seed_user(&pool, &auth_store, "docmeta-owner-gql06").await;
  let workspace_id = crate::helpers::create_workspace(&pool, owner_id).await;
  let doc_id = crate::helpers::create_doc(&pool, workspace_id, owner_id).await;
  let before_updated_at: DateTime<Utc> = sqlx::query_scalar("SELECT updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read content updated_at before subsystem mutation");
  let before_projection = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { projectionVersion metadataRevision } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    before_projection.get("errors").is_none(),
    "native projection read before subsystem write failed: {before_projection}"
  );
  let before_projection_version = before_projection
    .pointer("/data/documentMetadata/projectionVersion")
    .and_then(Value::as_str)
    .expect("projection version before subsystem write")
    .to_string();
  let before_revision = before_projection
    .pointer("/data/documentMetadata/metadataRevision")
    .and_then(Value::as_i64)
    .expect("metadata revision before subsystem write");

  let body = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "mutation M($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) { setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) { metadata { projectionVersion metadataRevision template { state category tags } presentation { primaryMode pageWidth edgelessColorTheme } integration { integrationType } } } }",
      "variables": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "input": {
          "templateState": "managed",
          "templateOrigin": "custom",
          "templateCategory": "building-blocks",
          "templateTags": ["project"],
          "primaryMode": "edgeless",
          "pageWidth": "fullWidth",
          "edgelessColorTheme": "system",
          "integrationType": "readwise"
        }
      }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;

  assert!(
    body.get("errors").is_none(),
    "subsystem metadata mutation failed: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/template/state")
      .and_then(Value::as_str),
    Some("managed"),
    "template state must come from document_template_state: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/presentation/primaryMode")
      .and_then(Value::as_str),
    Some("edgeless"),
    "presentation primaryMode must come from document_presentation_state: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/presentation/pageWidth")
      .and_then(Value::as_str),
    Some("fullWidth"),
    "presentation pageWidth must come from document_presentation_state: {body}"
  );
  assert_eq!(
    body
      .pointer("/data/setDocumentMetadata/metadata/integration/integrationType")
      .and_then(Value::as_str),
    Some("readwise"),
    "integrationType must come from document_integration_state: {body}"
  );
  let revision = body
    .pointer("/data/setDocumentMetadata/metadata/metadataRevision")
    .and_then(Value::as_i64)
    .expect("metadata revision");
  assert!(
    revision >= before_revision + 3,
    "template, presentation and integration subsystem writes must advance metadataRevision; got {revision}: {body}"
  );
  let mutation_projection_version = body
    .pointer("/data/setDocumentMetadata/metadata/projectionVersion")
    .and_then(Value::as_str)
    .expect("projection version after subsystem mutation");
  assert_ne!(
    mutation_projection_version, before_projection_version,
    "subsystem metadata writes must change projectionVersion for client freshness without using docs.updated_at"
  );
  let after_updated_at: DateTime<Utc> = sqlx::query_scalar("SELECT updated_at FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("read content updated_at after subsystem mutation");
  assert_eq!(
    after_updated_at, before_updated_at,
    "subsystem metadata writes must not touch docs.updated_at; projectionVersion/metadataRevision are the freshness markers"
  );

  let read_back = crate::helpers::gql_with_headers(
    &app,
    owner_session,
    json!({
      "query": "query Q($workspaceId: ID!, $docId: ID!) { documentMetadata(workspaceId: $workspaceId, docId: $docId) { projectionVersion metadataRevision template { state category tags } presentation { primaryMode pageWidth edgelessColorTheme } integration { integrationType } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
    &[("x-myoxus-client-format", "myoxus-native")],
  )
  .await;
  assert!(
    read_back.get("errors").is_none(),
    "native subsystem read failed: {read_back}"
  );
  assert_eq!(
    read_back
      .pointer("/data/documentMetadata/presentation/edgelessColorTheme")
      .and_then(Value::as_str),
    Some("system"),
    "native read must expose the same canonical subsystem projection: {read_back}"
  );
  assert_eq!(
    read_back
      .pointer("/data/documentMetadata/projectionVersion")
      .and_then(Value::as_str),
    Some(mutation_projection_version),
    "fresh read must expose the same subsystem-driven projectionVersion returned by the write: {read_back}"
  );

  assert_eq!(
    read_back.pointer("/data/documentMetadata/template"),
    Some(&json!({"state": "managed", "category": "building-blocks", "tags": ["project"]})),
    "custom classification must round-trip through the acknowledged metadata head"
  );

  crate::helpers::cleanup_users(&pool, &[owner_id]).await;
}
