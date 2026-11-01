// SPDX-License-Identifier: AGPL-3.0-or-later
//! Migration-level invariants for canonical document metadata.
//!
//! These tests intentionally exercise SQL contracts before the P-DOC-ATTR-C
//! repository layer exists. They must not leave rows behind in the shared test
//! database.

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

use myoxus_domain::entities::{
  DocumentMetadataFieldDefinition, DocumentMetadataFieldDefinitionPatch, DocumentMetadataValueDefinition,
};
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, RepositoryError};
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;

async fn setup_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  PgPoolOptions::new()
    .max_connections(2)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("test DB connection failed")
}

async fn migrate(pool: &PgPool) {
  myoxus_infrastructure::migrations::run(pool).await.expect("migrate");
}

async fn seed_doc(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
  let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocAttrTest') RETURNING id")
    .bind(format!("docattr-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .expect("insert user");

  let ws_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'DocAttr WS') RETURNING id")
      .bind(user_id)
      .fetch_one(pool)
      .await
      .expect("insert workspace");

  let doc_id: Uuid = sqlx::query_scalar(
    "INSERT INTO docs (workspace_id, title, created_by) VALUES ($1, 'DocAttr Doc', $2) RETURNING id",
  )
  .bind(ws_id)
  .bind(user_id)
  .fetch_one(pool)
  .await
  .expect("insert doc");

  (user_id, ws_id, doc_id)
}

async fn cleanup_doc(pool: &PgPool, user_id: Uuid, ws_id: Uuid, doc_id: Uuid) {
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .expect("cleanup doc");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user");
}

async fn cleanup_docs(pool: &PgPool, user_id: Uuid, ws_id: Uuid, doc_ids: &[Uuid]) {
  sqlx::query("DELETE FROM document_version WHERE doc_id = ANY($1)")
    .bind(doc_ids)
    .execute(pool)
    .await
    .expect("cleanup document versions");
  sqlx::query("DELETE FROM doc_histories WHERE doc_id = ANY($1)")
    .bind(doc_ids)
    .execute(pool)
    .await
    .expect("cleanup doc histories");
  sqlx::query("DELETE FROM docs WHERE id = ANY($1)")
    .bind(doc_ids)
    .execute(pool)
    .await
    .expect("cleanup docs");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("cleanup user");
}

fn bucket_count(buckets: &[myoxus_domain::entities::DocumentRuntimeAggregateBucket], key: Option<&str>) -> i64 {
  buckets
    .iter()
    .find(|bucket| bucket.key.as_deref() == key)
    .map(|bucket| bucket.count)
    .unwrap_or(0)
}

#[tokio::test]
async fn inv_docattr_mig01_seeded_field_keys_are_stable() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM document_metadata_field_definition ORDER BY key")
    .fetch_all(&pool)
    .await
    .expect("select attribute keys");

  assert_eq!(
    keys,
    vec![
      "audience",
      "classification",
      "createdAt",
      "createdBy",
      "documentNumber",
      "documentType",
      "journalDate",
      "language",
      "metadataRevision",
      "responsible",
      "retentionPolicy",
      "reviewDueAt",
      "status",
      "templateState",
      "updatedAt",
      "updatedBy",
      "validFrom",
      "validUntil",
      "version",
    ],
    "canonical document metadata field keys must be exact and stable"
  );
}

#[tokio::test]
async fn inv_docattr_mig02_status_presets_have_transitions() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let schemas: Vec<(String, String)> =
    sqlx::query_as("SELECT key, complexity FROM document_status_schema WHERE is_preset = true ORDER BY key")
      .fetch_all(&pool)
      .await
      .expect("select schemas");
  assert_eq!(
    schemas,
    vec![
      ("controlled".to_string(), "controlled".to_string()),
      ("review".to_string(), "review".to_string()),
      ("simple".to_string(), "simple".to_string()),
    ],
    "simple, review and controlled presets must exist"
  );

  for key in ["simple", "review", "controlled"] {
    let status_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM document_status_value v JOIN document_status_schema s ON s.id = v.schema_id WHERE s.key = $1",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("count status values");
    assert!(status_count >= 4, "schema {key} must have useful status values");

    let transition_count: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM document_status_transition t JOIN document_status_value f ON f.id = t.from_status_id JOIN document_status_schema s ON s.id = f.schema_id WHERE s.key = $1",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("count transitions");
    assert!(transition_count > 0, "schema {key} must have transitions");
  }
}

#[tokio::test]
async fn inv_docattr_mig03_used_values_are_deactivated_not_deleted() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let mut tx = pool.begin().await.expect("begin tx");
  let id: Uuid = sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = 'internal'")
    .fetch_one(&mut *tx)
    .await
    .expect("select classification value");

  sqlx::query("UPDATE document_classification_definition SET is_active = false WHERE id = $1")
    .bind(id)
    .execute(&mut *tx)
    .await
    .expect("deactivate value");

  let still_present: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM document_classification_definition WHERE id = $1 AND is_active = false)",
  )
  .bind(id)
  .fetch_one(&mut *tx)
  .await
  .expect("check deactivated value still present");
  assert!(
    still_present,
    "used value lists must support deactivate-not-delete semantics"
  );

  tx.rollback().await.expect("rollback deactivate test");
}

#[tokio::test]
async fn inv_docattr_mig04_valid_until_before_valid_from_rejected() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (user_id, ws_id, doc_id) = seed_doc(&pool).await;

  sqlx::query("UPDATE docs SET valid_from = now(), valid_until = NULL WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("from/null valid range is allowed");

  sqlx::query("UPDATE docs SET valid_from = NULL, valid_until = now() WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("null/until valid range is allowed");

  sqlx::query("UPDATE docs SET valid_from = now(), valid_until = now() + interval '1 day' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("ordered valid range is allowed");

  let invalid = sqlx::query("UPDATE docs SET valid_from = now(), valid_until = now() - interval '1 day' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await;
  assert!(
    invalid.is_err(),
    "valid_until before valid_from must be rejected by DB constraint"
  );

  cleanup_doc(&pool, user_id, ws_id, doc_id).await;
}

#[tokio::test]
async fn inv_docattr_repo01_definitions_update_but_unknown_keys_reject() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let repo = PgDocumentMetadataPolicyRepository::new(pool.clone());

  let original = repo
    .get_metadata_field_definition("classification")
    .await
    .expect("read classification definition")
    .expect("classification definition exists");
  let updated = repo
    .update_metadata_field_definition(
      "classification",
      &DocumentMetadataFieldDefinitionPatch {
        export_mode: Some("required".to_string()),
        ..DocumentMetadataFieldDefinitionPatch::default()
      },
    )
    .await
    .expect("update classification export mode");
  assert_eq!(updated.export_mode, "required");

  repo
    .update_metadata_field_definition(
      "classification",
      &DocumentMetadataFieldDefinitionPatch {
        export_mode: Some(original.export_mode),
        ..DocumentMetadataFieldDefinitionPatch::default()
      },
    )
    .await
    .expect("restore classification export mode");

  let unknown = DocumentMetadataFieldDefinition {
    key: format!("unknown-{}", Uuid::new_v4()),
    label: "Unknown".to_string(),
    enabled: true,
    required_mode: "never".to_string(),
    editable_by: "editor".to_string(),
    visible_in_header: false,
    visible_in_properties: true,
    visible_in_lists: true,
    export_mode: "optional".to_string(),
    validation_config: serde_json::json!({}),
    metadata: serde_json::json!({}),
    updated_by: None,
    updated_at: chrono::Utc::now(),
  };
  let err = repo
    .create_metadata_field_definition(&unknown)
    .await
    .expect_err("unknown canonical key must be rejected by DB constraint");
  assert!(matches!(err, RepositoryError::Validation(_)));
}

#[tokio::test]
async fn inv_docattr_repo02_value_definitions_unique_per_field_key() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let repo = PgDocumentMetadataPolicyRepository::new(pool.clone());
  let key = format!("test-{}", Uuid::new_v4().simple());
  let value = DocumentMetadataValueDefinition {
    id: Uuid::new_v4(),
    field_key: "classification".to_string(),
    key: key.clone(),
    label: "Test classification".to_string(),
    description: None,
    color: None,
    icon: None,
    sort_order: 999,
    is_active: true,
    metadata: serde_json::json!({}),
  };
  let created = repo
    .create_metadata_value_definition(&value)
    .await
    .expect("create classification value");
  let err = repo
    .create_metadata_value_definition(&DocumentMetadataValueDefinition {
      id: Uuid::new_v4(),
      ..value
    })
    .await
    .expect_err("duplicate value key per attribute must fail");
  assert!(matches!(err, RepositoryError::Conflict(_)));

  sqlx::query("DELETE FROM document_classification_definition WHERE id = $1")
    .bind(created.id)
    .execute(&pool)
    .await
    .expect("cleanup test value");
}

#[tokio::test]
async fn inv_docattr_repo03_status_transition_without_edge_is_not_allowed() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let repo = PgDocumentMetadataPolicyRepository::new(pool);
  let values = repo.list_status_values("review").await.expect("review statuses");
  let draft = values.iter().find(|value| value.key == "draft").expect("draft").id;
  let approved = values
    .iter()
    .find(|value| value.key == "approved")
    .expect("approved")
    .id;
  let in_review = values
    .iter()
    .find(|value| value.key == "in_review")
    .expect("in_review")
    .id;

  assert!(
    repo
      .transition_exists(draft, in_review)
      .await
      .expect("known transition"),
    "draft -> in_review must be seeded"
  );
  assert!(
    !repo
      .transition_exists(draft, approved)
      .await
      .expect("missing transition"),
    "draft -> approved has no direct edge and must be blocked by services"
  );
}

#[tokio::test]
async fn inv_docattr_repo04_runtime_overview_counts_configured_and_synthetic_buckets() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let repo = PgDocumentMetadataPolicyRepository::new(pool.clone());
  let (user_id, ws_id, doc_id) = seed_doc(&pool).await;
  let second_doc_id: Uuid = sqlx::query_scalar(
    "INSERT INTO docs (workspace_id, title, created_by) VALUES ($1, 'DocAttr Runtime Doc 2', $2) RETURNING id",
  )
  .bind(ws_id)
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("insert second doc");

  let status_id: Uuid = sqlx::query_scalar(
    "SELECT v.id FROM document_status_value v JOIN document_status_schema s ON s.id = v.schema_id WHERE s.key = 'review' AND v.key = 'draft'",
  )
  .fetch_one(&pool)
  .await
  .expect("review draft status");
  let type_id: Uuid = sqlx::query_scalar("SELECT id FROM document_type_definition WHERE key = 'concept'")
    .fetch_one(&pool)
    .await
    .expect("concept doc type");
  let classification_id: Uuid =
    sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = 'internal'")
      .fetch_one(&pool)
      .await
      .expect("internal classification");
  let history_id: i64 = sqlx::query_scalar(
    "INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, '\\x00'::bytea) RETURNING id",
  )
  .bind(doc_id)
  .bind(ws_id)
  .fetch_one(&pool)
  .await
  .expect("insert doc history");
  let version_id: Uuid = sqlx::query_scalar(
    "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by, kind, is_protected) \
     VALUES ($1, $2, $3, $4, $5, 'published', true) RETURNING id",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(history_id)
  .bind(format!("runtime-overview-{}", Uuid::new_v4()))
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("insert document version");
  sqlx::query(
    "UPDATE docs \
     SET status_id = $2, document_type_id = $3, classification_id = $4, review_due_at = now() + interval '3 days', \
         current_version_id = $5, dirty_since_current_version = false, metadata_updated_by = $6 \
     WHERE id = $1",
  )
  .bind(doc_id)
  .bind(status_id)
  .bind(type_id)
  .bind(classification_id)
  .bind(version_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert document metadata state");

  let overview = repo.document_runtime_overview().await.expect("runtime overview");

  assert!(overview.total_documents >= 2);
  assert!(bucket_count(&overview.by_status, Some("draft")) >= 1);
  assert!(bucket_count(&overview.by_status, Some("in_progress")) >= 1);
  assert_eq!(
    bucket_count(&overview.by_status, None),
    0,
    "documents without explicit state inherit the effective default status"
  );
  assert!(bucket_count(&overview.by_document_type, Some("concept")) >= 1);
  assert!(bucket_count(&overview.by_document_type, None) >= 1);
  assert!(bucket_count(&overview.by_classification, Some("internal")) >= 1);
  assert!(bucket_count(&overview.by_classification, None) >= 1);
  assert!(bucket_count(&overview.by_review_due, Some("due_7d")) >= 1);
  assert!(bucket_count(&overview.by_review_due, Some("no_review")) >= 1);
  assert!(bucket_count(&overview.by_version_state, Some("protected_current")) >= 1);
  assert!(bucket_count(&overview.by_version_state, Some("no_current_version")) >= 1);
  assert!(
    overview.by_review_due.iter().all(|bucket| bucket.label.is_none()),
    "synthetic review buckets are technical keys; clients localize them"
  );
  assert!(
    overview.by_version_state.iter().all(|bucket| bucket.label.is_none()),
    "synthetic version buckets are technical keys; clients localize them"
  );

  cleanup_docs(&pool, user_id, ws_id, &[doc_id, second_doc_id]).await;
}

#[test]
fn inv_docattr_repo05_attribute_state_upsert_api_is_removed() {
  let repository_source = include_str!("../src/document_metadata_policy/mod.rs");
  let domain_repository_source = include_str!("../../domain/src/repositories.rs");

  assert!(
    !repository_source.contains("upsert_attribute_state"),
    "PgDocumentMetadataPolicyRepository must not expose a generic attribute-state write path"
  );
  assert!(
    !domain_repository_source.contains("upsert_attribute_state"),
    "DocumentMetadataPolicyRepository must not keep a generic attribute-state write method"
  );
}
