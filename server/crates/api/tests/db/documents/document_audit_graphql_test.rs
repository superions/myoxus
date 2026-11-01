// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariants for the admin document-audit GraphQL projection.
//!
//! INV-DOC-AUDIT-01: `adminDocumentAuditLog` never leaks generic admin events.
//! INV-DOC-AUDIT-02: group/doc filters include PDF render-audit evidence.
//! INV-DOC-AUDIT-03: invalid generic audit categories fail closed.
//! INV-DOC-AUDIT-04: docId filters use the canonical client-doc-id parser.
//! INV-DOC-AUDIT-05: real document-version mutations are projected, not only
//! manually seeded audit rows.
//! INV-DOC-AUDIT-06: document-versioning workspace settings stay in the
//! document audit projection and receive server-owned target labels.
//! INV-DOC-AUDIT-07: permanent document deletes are projected as document
//! lifecycle events, not as generic audit noise.
//! INV-DOC-AUDIT-08: initial sync provenance audit is exposed as document
//! lifecycle evidence.

use crate::helpers;
use serde_json::json;
use uuid::Uuid;

#[test]
fn inv_doc_audit01_projection_excludes_global_admin_audit() {
  helpers::block_on_large_stack("inv-doc-audit01-projection", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let tag = Uuid::new_v4().simple().to_string();
    let doc_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    seed_document_audit_rows(&pool, admin_id, &tag, workspace_id, doc_id, version_id, job_id).await;
    let global_target_id = format!("global-{tag}");

    let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query Q { admin { adminDocumentAuditLog(limit: 100, offset: 0) { eventKey sourceCategory group target { id type } } } }"
    }),
  )
  .await;
    assert!(body.get("errors").is_none(), "adminDocumentAuditLog failed: {body}");
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert!(
      entries.iter().all(|entry| {
        entry["target"]["id"].as_str() != Some(global_target_id.as_str())
          && entry["sourceCategory"].as_str() != Some("organization")
      }),
      "INV-DOC-AUDIT-01: document audit leaked a generic admin event: {body}"
    );
    assert!(
      entries
        .iter()
        .any(|entry| entry["eventKey"].as_str() == Some("document_metadata.set")),
      "INV-DOC-AUDIT-01: document metadata evidence missing: {body}"
    );
    assert!(
      entries
        .iter()
        .any(|entry| entry["eventKey"].as_str() == Some("document_version.create")),
      "INV-DOC-AUDIT-01: document version evidence missing: {body}"
    );

    cleanup_seeded_document_audit_rows(&pool, &tag, job_id).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit02_pdf_render_group_is_document_scoped_and_counted() {
  helpers::block_on_large_stack("inv-doc-audit02-pdf", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let tag = Uuid::new_v4().simple().to_string();
    let doc_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    seed_document_audit_rows(&pool, admin_id, &tag, workspace_id, doc_id, version_id, job_id).await;

    let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 10, offset: 0) { eventKey group source docId workspaceId target { id type } newValue } adminDocumentAuditLogCount(filter: $filter) } }",
      "variables": { "filter": { "groups": ["pdf_export"], "docId": doc_id.to_string() } }
    }),
  )
  .await;
    assert!(body.get("errors").is_none(), "pdf document audit query failed: {body}");
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert_eq!(
      entries.len(),
      1,
      "INV-DOC-AUDIT-02: expected exactly one pdf entry: {body}"
    );
    let entry = &entries[0];
    assert_eq!(entry["eventKey"].as_str(), Some("pdf_export.render"));
    assert_eq!(entry["group"].as_str(), Some("pdf_export"));
    assert_eq!(entry["source"].as_str(), Some("pdf_export_render_audit"));
    assert_eq!(entry["docId"].as_str(), Some(doc_id.to_string().as_str()));
    assert_eq!(entry["workspaceId"].as_str(), Some(workspace_id.to_string().as_str()));
    assert_eq!(
      body["data"]["admin"]["adminDocumentAuditLogCount"].as_i64(),
      Some(1),
      "INV-DOC-AUDIT-02: count must match filtered pdf evidence"
    );

    cleanup_seeded_document_audit_rows(&pool, &tag, job_id).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit03_generic_audit_rejects_unknown_category() {
  helpers::block_on_large_stack("inv-doc-audit03-invalid-category", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

    let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query Q { admin { adminAuditLog(filter: { category: \"document_attribute\" }, limit: 10, offset: 0) { id } } }"
    }),
  )
  .await;
    assert!(
      body.get("errors").is_some(),
      "INV-DOC-AUDIT-03: invalid category must fail closed, not widen to global audit: {body}"
    );

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit04_doc_id_filter_accepts_internal_doc_ids() {
  helpers::block_on_large_stack("inv-doc-audit04-internal-doc-id", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let tag = Uuid::new_v4().simple().to_string();
    let doc_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    seed_document_audit_rows(&pool, admin_id, &tag, workspace_id, doc_id, version_id, job_id).await;

    let body = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 10, offset: 0) { eventKey group docId } } }",
      "variables": { "filter": { "groups": ["document_metadata"], "docId": doc_id.to_string() } }
    }),
  )
  .await;
    assert!(
      body.get("errors").is_none(),
      "INV-DOC-AUDIT-04: client docId must be accepted by canonical parser: {body}"
    );
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert_eq!(
      entries.len(),
      1,
      "INV-DOC-AUDIT-04: expected one document metadata row for client doc id: {body}"
    );
    assert_eq!(entries[0]["eventKey"].as_str(), Some("document_metadata.set"));
    assert_eq!(entries[0]["docId"].as_str(), Some(doc_id.to_string().as_str()));

    cleanup_seeded_document_audit_rows(&pool, &tag, job_id).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit05_real_document_version_mutations_are_projected() {
  helpers::block_on_large_stack("inv-doc-audit05-real-document-version-events", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, admin_id).await;

    let create = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($workspaceId: ID!, $docId: ID!) { createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: \"audit-projection\", description: \"projection guard\") { id label } }",
        "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
      }),
    )
    .await;
    assert!(
      create.get("errors").is_none(),
      "INV-DOC-AUDIT-05: createDocumentVersion failed: {create}"
    );
    let version_id = create
      .pointer("/data/createDocumentVersion/id")
      .and_then(|value| value.as_str())
      .expect("created version id")
      .to_string();

    for (label, mutation) in [
      (
        "pin",
        "mutation M($id: ID!) { pinDocumentVersion(id: $id) { id isPinned } }",
      ),
      (
        "unpin",
        "mutation M($id: ID!) { unpinDocumentVersion(id: $id) { id isPinned } }",
      ),
      (
        "update",
        "mutation M($id: ID!) { updateDocumentVersion(id: $id, label: \"audit-projection-renamed\", description: \"projection guard updated\") { id label description } }",
      ),
    ] {
      let body = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": mutation,
          "variables": { "id": version_id }
        }),
      )
      .await;
      assert!(
        body.get("errors").is_none(),
        "INV-DOC-AUDIT-05: {label} mutation failed: {body}"
      );
    }

    let settings = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($workspaceId: ID!, $docId: ID!, $triggers: [AutoVersionTriggerType!]) { updateDocumentVersioningSettings(workspaceId: $workspaceId, docId: $docId, enabled: true, retentionCount: 7, autoVersionOn: $triggers) { docId enabled retentionCount autoVersionOn } }",
        "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string(), "triggers": ["on_pdf_export"] }
      }),
    )
    .await;
    assert!(
      settings.get("errors").is_none(),
      "INV-DOC-AUDIT-05: updateDocumentVersioningSettings failed: {settings}"
    );

    let delete = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation M($id: ID!) { deleteDocumentVersion(id: $id) }",
        "variables": { "id": version_id }
      }),
    )
    .await;
    assert!(
      delete.get("errors").is_none(),
      "INV-DOC-AUDIT-05: deleteDocumentVersion failed: {delete}"
    );

    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 20, offset: 0) { eventKey group sourceCategory docId workspaceId target { id type } newValue oldValue } adminDocumentAuditLogCount(filter: $filter) } }",
        "variables": { "filter": { "groups": ["document_version"], "docId": doc_id.to_string() } }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "INV-DOC-AUDIT-05: document audit projection failed: {body}"
    );
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    let doc_id_text = doc_id.to_string();
    let workspace_id_text = workspace_id.to_string();
    let event_keys: Vec<&str> = entries.iter().filter_map(|entry| entry["eventKey"].as_str()).collect();
    for expected in [
      "document_version.create",
      "document_version.pin",
      "document_version.unpin",
      "document_version.update",
      "document_version.settings.update",
      "document_version.delete",
    ] {
      assert!(
        event_keys.contains(&expected),
        "INV-DOC-AUDIT-05: missing {expected} in projected document-version audit: {body}"
      );
    }
    assert!(
      entries.iter().all(|entry| {
        entry["group"].as_str() == Some("document_version")
          && entry["sourceCategory"].as_str() == Some("document_version")
          && entry["docId"].as_str() == Some(doc_id_text.as_str())
          && entry["workspaceId"].as_str() == Some(workspace_id_text.as_str())
      }),
      "INV-DOC-AUDIT-05: projected rows must stay document-scoped and workspace-scoped: {body}"
    );
    assert_eq!(
      body["data"]["admin"]["adminDocumentAuditLogCount"].as_i64(),
      Some(6),
      "INV-DOC-AUDIT-05: count must include all real version lifecycle events: {body}"
    );

    sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(admin_id)
      .execute(&pool)
      .await
      .ok();
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit06_workspace_versioning_settings_are_projected_with_target_label() {
  helpers::block_on_large_stack("inv-doc-audit06-workspace-versioning-settings", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let tag = Uuid::new_v4().simple().to_string();

    sqlx::query(
      "INSERT INTO admin_audit_log \
         (id, event_key, category, target_type, target_id, target_label, actor_user_id, actor_label, new_value, metadata, created_at) \
       VALUES ($1, 'document_versioning.workspace_settings.update', 'document_version', 'workspace', $2, NULL, $3, 'admin', $4, $5, now())",
    )
    .bind(Uuid::new_v4())
    .bind(workspace_id.to_string())
    .bind(admin_id)
    .bind(json!({ "workspaceId": workspace_id.to_string(), "autoVersionOnPdfExport": true }))
    .bind(json!({ "testTag": tag }))
    .execute(&pool)
    .await
    .expect("seed document-versioning workspace settings audit row");

    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 10, offset: 0) { eventKey group workspaceId target { id type label } } } }",
        "variables": { "filter": { "groups": ["workspace_settings"], "workspaceId": workspace_id.to_string() } }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "INV-DOC-AUDIT-06: document audit projection failed: {body}"
    );
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert_eq!(
      entries.len(),
      1,
      "INV-DOC-AUDIT-06: expected one workspace settings row: {body}"
    );
    let entry = &entries[0];
    assert_eq!(
      entry["eventKey"].as_str(),
      Some("document_versioning.workspace_settings.update")
    );
    assert_eq!(entry["group"].as_str(), Some("workspace_settings"));
    assert_eq!(entry["workspaceId"].as_str(), Some(workspace_id.to_string().as_str()));
    assert_eq!(entry["target"]["id"].as_str(), Some(workspace_id.to_string().as_str()));
    assert_eq!(entry["target"]["type"].as_str(), Some("workspace"));
    assert_eq!(
      entry["target"]["label"].as_str(),
      Some(format!("ws-{workspace_id}").as_str()),
      "INV-DOC-AUDIT-06: target label must be enriched from workspaces.name: {body}"
    );

    sqlx::query("DELETE FROM admin_audit_log WHERE metadata->>'testTag' = $1")
      .bind(tag)
      .execute(&pool)
      .await
      .ok();
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit07_document_lifecycle_delete_events_are_projected() {
  helpers::block_on_large_stack("inv-doc-audit07-document-lifecycle", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let tag = Uuid::new_v4().simple().to_string();
    let doc_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let version_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    seed_document_audit_rows(&pool, admin_id, &tag, workspace_id, doc_id, version_id, job_id).await;

    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 10, offset: 0) { eventKey group sourceCategory docId workspaceId target { id type label } newValue oldValue } adminDocumentAuditLogCount(filter: $filter) } }",
        "variables": { "filter": { "groups": ["document_lifecycle"], "docId": doc_id.to_string() } }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "INV-DOC-AUDIT-07: document lifecycle projection failed: {body}"
    );
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert_eq!(
      entries.len(),
      1,
      "INV-DOC-AUDIT-07: expected one permanent-delete lifecycle row: {body}"
    );
    let entry = &entries[0];
    assert_eq!(entry["eventKey"].as_str(), Some("document.delete_permanent"));
    assert_eq!(entry["group"].as_str(), Some("document_lifecycle"));
    assert_eq!(entry["sourceCategory"].as_str(), Some("document"));
    assert_eq!(entry["docId"].as_str(), Some(doc_id.to_string().as_str()));
    assert_eq!(entry["workspaceId"].as_str(), Some(workspace_id.to_string().as_str()));
    assert_eq!(entry["target"]["type"].as_str(), Some("document"));
    assert_eq!(entry["target"]["id"].as_str(), Some(doc_id.to_string().as_str()));
    assert_eq!(entry["target"]["label"].as_str(), Some("document"));
    assert_eq!(
      body["data"]["admin"]["adminDocumentAuditLogCount"].as_i64(),
      Some(1),
      "INV-DOC-AUDIT-07: count must match document lifecycle filter: {body}"
    );

    cleanup_seeded_document_audit_rows(&pool, &tag, job_id).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_doc_audit08_initial_sync_provenance_is_document_lifecycle_evidence() {
  helpers::block_on_large_stack("inv-doc-audit08-initial-sync", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, admin_id).await;

    sqlx::query(
      "INSERT INTO document_initial_sync_audit \
         (doc_id, workspace_id, actor_user_id, idempotency_key, provenance_mode, \
          received_at_server, resolution_kind, decision_code, raw_provenance, normalized_provenance, \
          applied_created_at, applied_updated_at, applied_created_by, applied_updated_by, rejected_fields) \
       VALUES ($1, $2, $3, $4, 'offline_sync', now(), 'created', 'accepted', $5, $6, now(), now(), $3, $3, '{}'::jsonb)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(admin_id)
    .bind(format!("audit08-{doc_id}"))
    .bind(json!({ "testCase": "audit08", "idempotencyKey": format!("audit08-{doc_id}") }))
    .bind(json!({ "clientFormat": "myoxus-native", "provenanceMode": "offline_sync" }))
    .execute(&pool)
    .await
    .expect("seed initial sync audit");

    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query Q($filter: AdminDocumentAuditFilterInput!) { admin { adminDocumentAuditLog(filter: $filter, limit: 10, offset: 0) { eventKey group source sourceCategory docId workspaceId target { id type } newValue metadata } adminDocumentAuditLogCount(filter: $filter) } }",
        "variables": {
          "filter": {
            "groups": ["document_lifecycle"],
            "docId": doc_id.to_string(),
            "eventKeyPrefix": "document.initial_sync."
          }
        }
      }),
    )
    .await;
    assert!(
      body.get("errors").is_none(),
      "INV-DOC-AUDIT-08: initial sync document audit query failed: {body}"
    );
    let entries = body["data"]["admin"]["adminDocumentAuditLog"]
      .as_array()
      .expect("entries array");
    assert_eq!(
      entries.len(),
      1,
      "INV-DOC-AUDIT-08: expected exactly one initial-sync audit row: {body}"
    );
    let entry = &entries[0];
    assert_eq!(entry["eventKey"].as_str(), Some("document.initial_sync.created"));
    assert_eq!(entry["group"].as_str(), Some("document_lifecycle"));
    assert_eq!(entry["source"].as_str(), Some("document_initial_sync_audit"));
    assert_eq!(entry["sourceCategory"].as_str(), Some("document_initial_sync_audit"));
    assert_eq!(entry["docId"].as_str(), Some(doc_id.to_string().as_str()));
    assert_eq!(entry["workspaceId"].as_str(), Some(workspace_id.to_string().as_str()));
    assert_eq!(entry["target"]["type"].as_str(), Some("document"));
    assert_eq!(
      entry["newValue"]["decisionCode"].as_str(),
      Some("accepted"),
      "initial sync decision must be visible in document audit payload: {body}"
    );
    assert_eq!(
      body["data"]["admin"]["adminDocumentAuditLogCount"].as_i64(),
      Some(1),
      "INV-DOC-AUDIT-08: count must include initial sync evidence"
    );

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

async fn seed_document_audit_rows(
  pool: &sqlx::PgPool,
  actor_id: Uuid,
  tag: &str,
  workspace_id: Uuid,
  doc_id: Uuid,
  version_id: Uuid,
  job_id: Uuid,
) {
  sqlx::query(
    "INSERT INTO admin_audit_log \
       (id, event_key, category, target_type, target_id, target_label, actor_user_id, actor_label, new_value, metadata, created_at) \
     VALUES \
       ($1, 'organization.policy.update', 'organization', 'organization', $2, 'global leak sentinel', $3, 'admin', '{}', $4, now()), \
       ($5, 'document_metadata.set', 'document_version', 'document', $6, 'document', $3, 'admin', $7, $4, now()), \
       ($8, 'document_version.create', 'document_version', 'document_version', $9, 'v1', $3, 'admin', $10, $4, now()), \
       ($11, 'document.delete_permanent', 'document', 'document', $6, 'document', $3, 'admin', $12, $4, now())",
  )
  .bind(Uuid::new_v4())
  .bind(format!("global-{tag}"))
  .bind(actor_id)
  .bind(json!({ "testTag": tag }))
  .bind(Uuid::new_v4())
  .bind(doc_id.to_string())
  .bind(json!({
    "docId": doc_id.to_string(),
    "workspaceId": workspace_id.to_string(),
    "diff": [{ "key": "classification", "oldValue": null, "newValue": "public" }]
  }))
  .bind(Uuid::new_v4())
  .bind(version_id.to_string())
  .bind(json!({
    "id": version_id.to_string(),
    "docId": doc_id.to_string(),
    "workspaceId": workspace_id.to_string(),
    "label": "v1"
  }))
  .bind(Uuid::new_v4())
  .bind(json!({
    "requested": 1,
    "deleted": 1,
    "workspaceId": workspace_id.to_string(),
    "docId": doc_id.to_string()
  }))
  .execute(pool)
  .await
  .expect("seed admin audit rows");

  sqlx::query(
    "INSERT INTO pdf_export_render_audit \
       (id, job_id, actor_id, workspace_id, doc_id, doc_version_label, document_version_id, \
        template_version, render_appearance_hash, locale, classification, l3_inputs, \
        document_metadata_snapshot, metadata_validation, created_at) \
     VALUES ($1, $2, $3, $4, $5, 'v1', $6, 'test-template-v1', $7, 'de-DE', 'public', $8, $9, $10, now())",
  )
  .bind(Uuid::new_v4())
  .bind(job_id)
  .bind(actor_id)
  .bind(workspace_id)
  .bind(doc_id)
  .bind(version_id)
  .bind("0".repeat(64))
  .bind(json!({ "testTag": tag, "paper_size": "A4" }))
  .bind(json!({ "docId": doc_id.to_string(), "classification": "public" }))
  .bind(json!({ "valid": true, "issues": [] }))
  .execute(pool)
  .await
  .expect("seed pdf render audit row");

  let seeded: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_audit_log WHERE metadata->>'testTag' = $1")
    .bind(tag)
    .fetch_one(pool)
    .await
    .expect("count seeded audit rows");
  assert_eq!(seeded, 4, "seed sanity check");
}

async fn cleanup_seeded_document_audit_rows(pool: &sqlx::PgPool, tag: &str, job_id: Uuid) {
  sqlx::query("DELETE FROM pdf_export_render_audit WHERE job_id = $1")
    .bind(job_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM admin_audit_log WHERE metadata->>'testTag' = $1")
    .bind(tag)
    .execute(pool)
    .await
    .ok();
}
