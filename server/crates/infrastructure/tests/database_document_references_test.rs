//! PostgreSQL invariants for the rebuildable Database document projection.

use myoxus_domain::database::DatabaseProjectionRepository;
use myoxus_domain::database::{DatabaseDocumentLinkValue, DatabaseDocumentReferenceKind};
use myoxus_domain::repositories::PageRequest;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use sqlx::PgPool;
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("test postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("database document-reference migration must apply");
  pool
}

#[tokio::test]
async fn index_row_replaces_typed_document_references_from_canonical_state() {
  let pool = setup_pool().await;
  let repo = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let owner_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let database_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  let field_id = Uuid::new_v4();
  let content_doc_id = Uuid::new_v4();
  let first_link_id = Uuid::new_v4();
  let second_link_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Reference owner', 'active')")
    .bind(owner_id)
    .bind(format!("database-reference-{owner_id}@example.test"))
    .execute(&pool)
    .await
    .expect("seed user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Reference workspace')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed workspace");
  for (doc_id, title) in [
    (content_doc_id, "Row content"),
    (first_link_id, "First target"),
    (second_link_id, "Second target"),
  ] {
    sqlx::query("INSERT INTO docs (id, workspace_id, title, created_at, updated_at) VALUES ($1, $2, $3, now(), now())")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(title)
      .execute(&pool)
      .await
      .expect("seed document");
  }
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'References', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed database");
  sqlx::query(
    "INSERT INTO workspace_database_fields (id, database_id, name, field_type, config_json, position, required) VALUES ($1, $2, 'Spec', 'document_link', '{\"kind\":\"document_link\"}', 0, false)",
  )
  .bind(field_id)
  .bind(database_id)
  .execute(&pool)
  .await
  .expect("seed DocumentLink field");
  sqlx::query(
    "INSERT INTO workspace_database_rows (id, database_id, doc_id, title, position, created_by, updated_by) VALUES ($1, $2, $3, 'Ship', 0, $4, $4)",
  )
  .bind(row_id)
  .bind(database_id)
  .bind(content_doc_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed row");
  sqlx::query(
    "INSERT INTO workspace_database_cell_values (row_id, field_id, database_id, value_json, updated_by) VALUES ($1, $2, $3, $4, $5)",
  )
  .bind(row_id)
  .bind(field_id)
  .bind(database_id)
  .bind(serde_json::to_value(DatabaseDocumentLinkValue { doc_id: first_link_id, workspace_id: None }).unwrap())
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed DocumentLink cell");

  repo
    .upsert_search_row(
      database_id,
      row_id,
      1,
      "Ship".to_string(),
      "spec".to_string(),
      Vec::new(),
    )
    .await
    .expect("index canonical row");
  repo
    .upsert_search_row(
      database_id,
      row_id,
      1,
      "Ship".to_string(),
      "spec".to_string(),
      Vec::new(),
    )
    .await
    .expect("repeat index is idempotent");

  let references = repo
    .list_document_references_for_targets(
      workspace_id,
      &[content_doc_id, first_link_id],
      PageRequest { limit: 100, offset: 0 },
    )
    .await
    .expect("read typed references");
  assert_eq!(references.len(), 2);
  assert!(references.iter().any(|reference| {
    reference.reference_kind == DatabaseDocumentReferenceKind::RowContentDocument
      && reference.field_id.is_none()
      && reference.resolved_target_doc_id == Some(content_doc_id)
  }));
  assert!(references.iter().any(|reference| {
    reference.reference_kind == DatabaseDocumentReferenceKind::DocumentLinkField
      && reference.field_id == Some(field_id)
      && reference.field_name.as_deref() == Some("Spec")
      && reference.resolved_target_doc_id == Some(first_link_id)
  }));
  let workspace_references = repo
    .list_document_references_for_workspace(workspace_id, PageRequest { limit: 100, offset: 0 })
    .await
    .expect("read workspace document references");
  assert_eq!(workspace_references, references);
  let occurrence_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM document_graph_occurrences WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("count real Yjs occurrences");
  assert_eq!(
    occurrence_count, 0,
    "Database Rows must not become synthetic Yjs occurrences"
  );

  sqlx::query("UPDATE workspace_database_cell_values SET value_json = $3 WHERE row_id = $1 AND field_id = $2")
    .bind(row_id)
    .bind(field_id)
    .bind(
      serde_json::to_value(DatabaseDocumentLinkValue {
        doc_id: second_link_id,
        workspace_id: None,
      })
      .unwrap(),
    )
    .execute(&pool)
    .await
    .expect("replace canonical DocumentLink value");
  repo
    .refresh_document_references_for_row(row_id)
    .await
    .expect("replace derived references");
  assert!(
    repo
      .list_document_references_for_targets(workspace_id, &[first_link_id], PageRequest { limit: 100, offset: 0 })
      .await
      .unwrap()
      .is_empty()
  );
  assert_eq!(
    repo
      .list_document_references_for_targets(workspace_id, &[second_link_id], PageRequest { limit: 100, offset: 0 })
      .await
      .unwrap()
      .len(),
    1
  );

  let content_refreshes = repo
    .list_document_reference_refreshes_for_target(workspace_id, content_doc_id)
    .await
    .expect("capture affected Row before canonical document delete");
  assert_eq!(content_refreshes.len(), 1);
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(content_doc_id)
    .execute(&pool)
    .await
    .expect("delete attached content document");
  repo
    .refresh_document_references_for_row(row_id)
    .await
    .expect("refresh projection after content-document delete");
  assert!(
    repo
      .list_document_references_for_targets(workspace_id, &[content_doc_id], PageRequest { limit: 100, offset: 0 })
      .await
      .unwrap()
      .is_empty(),
    "ON DELETE SET NULL plus indexRow refresh must remove Row content association"
  );

  let link_refreshes = repo
    .list_document_reference_refreshes_for_target(workspace_id, second_link_id)
    .await
    .expect("capture DocumentLink Row before target delete");
  assert_eq!(link_refreshes.len(), 1);
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(second_link_id)
    .execute(&pool)
    .await
    .expect("delete DocumentLink target");
  repo
    .refresh_document_references_for_row(row_id)
    .await
    .expect("refresh unresolved DocumentLink projection");
  let unresolved = repo
    .list_document_references_for_targets(workspace_id, &[second_link_id], PageRequest { limit: 100, offset: 0 })
    .await
    .expect("read unresolved raw target");
  assert_eq!(unresolved.len(), 1);
  assert_eq!(unresolved[0].resolved_target_doc_id, None);
  assert_eq!(unresolved[0].raw_target_doc_id, second_link_id.to_string());

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup workspace fixture");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("cleanup cascades fixture");
}
