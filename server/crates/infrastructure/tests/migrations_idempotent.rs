//! Final-schema and repository invariants owned by the migration suite.
//!
//! Historical replay and per-version checksum assertions intentionally do not
//! live here: the active contract is baseline 1000 plus append-only forward
//! migrations. Unsupported pre-baseline release ledgers are rejected by
//! `migration_baseline`.

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

#[path = "migrations_idempotent/database_membership.rs"]
mod database_membership;
#[path = "migrations_idempotent/database_read_path.rs"]
mod database_read_path;

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

#[tokio::test]
async fn inv_mig01_sqlx_migrate_is_idempotent_across_invocations() {
  let pool = setup_pool().await;

  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("first migrate run");

  let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
    .fetch_one(&pool)
    .await
    .expect("count migrations after first run");

  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("second migrate run must succeed (idempotent runner)");

  let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
    .fetch_one(&pool)
    .await
    .expect("count migrations after second run");
  assert_eq!(
    count_before, count_after,
    "second run must not insert new rows in _sqlx_migrations (idempotent contract)"
  );
  let mut tx = pool.begin().await.expect("isolated status constraint probe");
  let error = sqlx::query(
    "UPDATE document_status_value SET okf_status='invalid' WHERE id='3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a'",
  )
  .execute(&mut *tx)
  .await
  .expect_err("database must reject unknown OKF mappings");
  assert_eq!(
    error.as_database_error().and_then(|error| error.constraint()),
    Some("document_status_value_okf_status_check")
  );
  tx.rollback().await.expect("remove status constraint probe");
}

#[tokio::test]
async fn workspace_description_migration_enforces_the_empty_default_and_scalar_limit() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let mut tx = pool.begin().await.expect("transaction");
  let user_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Description migration') RETURNING id")
      .bind(format!("description-migration-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&mut *tx)
      .await
      .expect("insert user");
  let workspace_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Description migration') RETURNING id",
  )
  .bind(user_id)
  .fetch_one(&mut *tx)
  .await
  .expect("insert workspace");
  let description: String = sqlx::query_scalar("SELECT description FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await
    .expect("read default description");
  assert!(description.is_empty());

  let oversized = "😀".repeat(2001);
  let error = sqlx::query("UPDATE workspaces SET description = $2 WHERE id = $1")
    .bind(workspace_id)
    .bind(oversized)
    .execute(&mut *tx)
    .await
    .expect_err("database constraint must reject 2,001 Unicode scalars");
  assert_eq!(
    error.as_database_error().and_then(|error| error.constraint()),
    Some("workspaces_description_length")
  );
  tx.rollback().await.expect("rollback fixture");
}

#[tokio::test]
async fn inv_mig01_database_gantt_is_a_persistable_view_kind() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");

  let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Gantt migration') RETURNING id")
    .bind(format!("gantt-migration-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(&pool)
    .await
    .expect("insert user");
  let workspace_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Gantt migration') RETURNING id")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("insert workspace");
  let database_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspace_databases (workspace_id, title, created_by, updated_by) VALUES ($1, 'Gantt migration', $2, $2) RETURNING id",
  )
  .bind(workspace_id)
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("insert database");

  sqlx::query(
    "INSERT INTO workspace_database_views (database_id, name, view_kind, config_json, position) VALUES ($1, 'Gantt', 'gantt', '{\"kind\":\"gantt\"}'::jsonb, 0)",
  )
  .bind(database_id)
  .execute(&pool)
  .await
  .expect("Gantt view kind must pass the canonical constraint");
  let invalid = sqlx::query(
    "INSERT INTO workspace_database_views (database_id, name, view_kind, config_json, position) VALUES ($1, 'Unknown', 'unknown', '{\"kind\":\"unknown\"}'::jsonb, 1)",
  )
  .bind(database_id)
  .execute(&pool)
  .await;
  assert!(invalid.is_err(), "unknown view kinds must remain rejected");

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("delete Gantt migration workspace fixture");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("delete Gantt migration user fixture");
}

#[tokio::test]
async fn inv_mig01_v2_pdf_tables_present() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let mut tx = pool.begin().await.expect("begin isolated PDF schema fixture");

  // --- seed minimal users and workspace -------------------------------------------------------
  let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Test PDF') RETURNING id")
    .bind(format!("pdf-v2-test-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(&mut *tx)
    .await
    .expect("insert user");

  let ws_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'PDF V2 WS') RETURNING id")
      .bind(user_id)
      .fetch_one(&mut *tx)
      .await
      .expect("insert workspace");

  // --- pdf_templates --------------------------------------------------------------------------
  let tpl_id: Uuid = sqlx::query_scalar(
    r#"INSERT INTO pdf_templates (slug, name, version, schema_version, manifest, created_by)
       VALUES ($1, 'Test Template', '1.0.0', '2.0', '{"id":"test.tpl","schema_version":"2.0"}'::jsonb, $2)
       RETURNING id"#,
  )
  .bind(format!("test-tpl-{}", Uuid::new_v4()))
  .bind(user_id)
  .fetch_one(&mut *tx)
  .await
  .expect("insert pdf_templates");

  // --- pdf_template_files ---------------------------------------------------------------------
  sqlx::query(
    "INSERT INTO pdf_template_files (template_id, file_path, blob_key, content_hash)
     VALUES ($1, 'preamble.typ', 'pdf-templates/test/preamble.typ', 'abc123')",
  )
  .bind(tpl_id)
  .execute(&mut *tx)
  .await
  .expect("insert pdf_template_files");

  // Workspace creation may already assign the installed default template.
  sqlx::query("UPDATE pdf_workspace_template_assignments SET is_default = false WHERE workspace_id = $1")
    .bind(ws_id)
    .execute(&mut *tx)
    .await
    .expect("prepare the test-owned default assignment");

  // --- pdf_workspace_template_assignments (first default) ------------------------------------
  sqlx::query(
    "INSERT INTO pdf_workspace_template_assignments (workspace_id, template_id, is_default, assigned_by)
     VALUES ($1, $2, true, $3)",
  )
  .bind(ws_id)
  .bind(tpl_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("insert first assignment (default)");

  // --- split document branding and PDF export settings ---------------------------------------
  sqlx::query(
    "INSERT INTO document_brand_profiles (scope, workspace_id, footer_text, color_palette_key, updated_by)
     VALUES ('workspace', $1, 'Migration invariant footer', 'balanced', $2)",
  )
  .bind(ws_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("insert document_brand_profiles");

  sqlx::query(
    "INSERT INTO pdf_export_settings (scope, workspace_id, default_template_id, ligatures_enabled, updated_by)
     VALUES ('workspace', $1, $2, true, $3)",
  )
  .bind(ws_id)
  .bind(tpl_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("insert pdf_export_settings");

  let ligatures: bool = sqlx::query_scalar("SELECT ligatures_enabled FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&mut *tx)
    .await
    .expect("select pdf export settings");
  assert!(ligatures, "ligatures_enabled must default to true");

  // --- pdf_fonts ------------------------------------------------------------------------------
  let font_sha = format!("sha256-{}", Uuid::new_v4().simple());
  sqlx::query(
    "INSERT INTO pdf_fonts (family_name, style, weight, blob_key, sha256, license, uploaded_by)
     VALUES ('TestFont', 'Regular', 400, 'pdf-fonts/test.otf', $1, 'OFL-1.1', $2)",
  )
  .bind(&font_sha)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("insert pdf_fonts");

  let status: String = sqlx::query_scalar("SELECT license_status FROM pdf_fonts WHERE sha256 = $1")
    .bind(&font_sha)
    .fetch_one(&mut *tx)
    .await
    .expect("select font");
  assert_eq!(status, "pending", "license_status must default to 'pending'");

  // --- partial unique index: second is_default=true for same workspace must fail -------------
  let tpl2_id: Uuid = sqlx::query_scalar(
    r#"INSERT INTO pdf_templates (slug, name, version, schema_version, manifest, created_by)
       VALUES ($1, 'Test Template 2', '1.0.0', '2.0', '{}'::jsonb, $2)
       RETURNING id"#,
  )
  .bind(format!("test-tpl-2-{}", Uuid::new_v4()))
  .bind(user_id)
  .fetch_one(&mut *tx)
  .await
  .expect("insert second template");

  let mut duplicate = sqlx::Acquire::begin(&mut tx)
    .await
    .expect("begin expected constraint failure");
  let dup_result = sqlx::query(
    "INSERT INTO pdf_workspace_template_assignments (workspace_id, template_id, is_default, assigned_by)
     VALUES ($1, $2, true, $3)",
  )
  .bind(ws_id)
  .bind(tpl2_id)
  .bind(user_id)
  .execute(&mut *duplicate)
  .await;

  duplicate
    .rollback()
    .await
    .expect("rollback expected duplicate assignment");
  assert_eq!(
    dup_result
      .as_ref()
      .err()
      .and_then(sqlx::Error::as_database_error)
      .and_then(|error| error.code())
      .as_deref(),
    Some("23505"),
    "inserting a second is_default=true row for the same workspace must violate uniq_default_per_ws"
  );

  // --- FK CASCADE: deleting workspace must remove split owner rows ----------------------------
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
    .execute(&mut *tx)
    .await
    .expect("delete workspace");

  let brand_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&mut *tx)
    .await
    .expect("count document branding after cascade");
  assert_eq!(brand_count, 0, "CASCADE DELETE must remove document_brand_profiles row");

  let settings_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_settings WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&mut *tx)
    .await
    .expect("count pdf export settings after cascade");
  assert_eq!(settings_count, 0, "CASCADE DELETE must remove pdf_export_settings row");

  let assign_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM pdf_workspace_template_assignments WHERE workspace_id = $1")
      .bind(ws_id)
      .fetch_one(&mut *tx)
      .await
      .expect("count assignments after cascade");
  assert_eq!(
    assign_count, 0,
    "CASCADE DELETE must remove pdf_workspace_template_assignments rows"
  );

  tx.rollback().await.expect("remove all PDF schema fixture data");
}

// ---------------------------------------------------------------------------
// P-PDF-TPL-01-08  inv_mig02_v2_idempotent
// ---------------------------------------------------------------------------
// A second migrate!().run() call must not insert additional rows into
// the canonical baseline ledger.
#[tokio::test]
async fn inv_mig01_v3_doc_version_tables_present() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");

  // Seed: user + workspace + doc
  let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocVer Test') RETURNING id")
    .bind(format!("docver-mig-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(&pool)
    .await
    .expect("insert user");

  let ws_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'DocVer WS') RETURNING id")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("insert workspace");

  let doc_id: Uuid =
    sqlx::query_scalar("INSERT INTO docs (workspace_id, title) VALUES ($1, 'DocVer Doc') RETURNING id")
      .bind(ws_id)
      .fetch_one(&pool)
      .await
      .expect("insert doc");

  // Seed: doc_history (id is BIGINT GENERATED ALWAYS AS IDENTITY)
  let history_id: i64 =
    sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
      .bind(doc_id)
      .bind(ws_id)
      .bind(b"snapshot-bytes" as &[u8])
      .fetch_one(&pool)
      .await
      .expect("insert doc_history");

  // Insert a document_version row
  let version_id: Uuid = sqlx::query_scalar(
    r#"INSERT INTO document_version
       (doc_id, workspace_id, doc_history_id, label, created_by)
       VALUES ($1, $2, $3, 'v1.0', $4)
       RETURNING id"#,
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(history_id)
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("insert document_version");

  // Assert: SELECT confirms the row
  let found_label: String = sqlx::query_scalar("SELECT label FROM document_version WHERE id = $1")
    .bind(version_id)
    .fetch_one(&pool)
    .await
    .expect("select document_version");
  assert_eq!(found_label, "v1.0", "label must round-trip");

  // Assert: UNIQUE(doc_id, label) — second insert with same label must fail
  let dup_result = sqlx::query(
    "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by)
     VALUES ($1, $2, $3, 'v1.0', $4)",
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(history_id)
  .bind(user_id)
  .execute(&pool)
  .await;
  assert!(
    dup_result.is_err(),
    "UNIQUE(doc_id, label) must reject duplicate label for the same doc"
  );

  // Assert: CASCADE delete — delete the doc, document_version must be gone
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("delete doc");

  let version_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM document_version WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count versions after cascade");
  assert_eq!(version_count, 0, "CASCADE DELETE must remove document_version rows");

  // Assert: doc_histories row is also gone because the doc was deleted (its FK
  // to docs is ON DELETE CASCADE). The doc_version FK to doc_histories is
  // ON DELETE RESTRICT, but since we deleted the doc_version first (via the
  // doc CASCADE), the doc_histories row is now also gone via its own CASCADE.
  let history_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE id = $1")
    .bind(history_id)
    .fetch_one(&pool)
    .await
    .expect("count histories after cascade");
  assert_eq!(
    history_count, 0,
    "doc_histories must also cascade-delete when doc is deleted"
  );

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_id)
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
async fn link_color_migration_preserves_custom_schemas_and_existing_overrides() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  let mut tx = pool.begin().await.expect("transaction");
  let id = Uuid::new_v4();
  sqlx::query("INSERT INTO color_schemas (id, slug, name, origin) VALUES ($1, $2, 'Link migration', 'custom')")
    .bind(id)
    .bind(format!("link-migration-{id}"))
    .execute(&mut *tx)
    .await
    .expect("custom schema");
  sqlx::query("INSERT INTO color_schema_values (schema_id, mode, token_key, value) VALUES ($1, 'light', 'accent-primary', '#123456'), ($1, 'dark', 'accent-primary', '#abcdef'), ($1, 'dark', 'link-default', '#fedcba')")
    .bind(id).execute(&mut *tx).await.expect("pre-migration values");
  for _ in 0..2 {
    sqlx::raw_sql(include_str!("../migrations/1010_theme_link_color.sql"))
      .execute(&mut *tx)
      .await
      .expect("backfill");
  }
  let values: Vec<(String, String)> = sqlx::query_as(
    "SELECT mode, value FROM color_schema_values WHERE schema_id = $1 AND token_key = 'link-default' ORDER BY mode",
  )
  .bind(id)
  .fetch_all(&mut *tx)
  .await
  .expect("links");
  assert_eq!(
    values,
    vec![("dark".into(), "#fedcba".into()), ("light".into(), "#123456".into())]
  );
  tx.rollback().await.expect("remove test schema");
}

#[tokio::test]
async fn inv_mig01_document_change_pending_tables_enforce_unique_windows_and_cascade() {
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrate pending windows");
  let mut tx = pool.begin().await.expect("isolated pending schema fixture");
  let user = Uuid::new_v4();
  let workspace = Uuid::new_v4();
  let doc = Uuid::new_v4();
  let batch = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email,name) VALUES($1,$2,'Migration batch')")
    .bind(user)
    .bind(format!("batch-{user}@myoxus.test"))
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$2,'Pending window migration')")
    .bind(workspace)
    .bind(user)
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by) VALUES($1,$2,$3,'Pending window',$4)")
    .bind(doc)
    .bind(workspace)
    .bind(doc.to_string())
    .bind(user)
    .execute(&mut *tx)
    .await
    .unwrap();
  let insert = "INSERT INTO document_change_batches(id,doc_id,workspace_id,started_at,last_changed_at,due_at,first_sequence,last_sequence) VALUES($1,$2,$3,now(),now(),now()+interval '10 minutes',1,1)";
  sqlx::query(insert)
    .bind(batch)
    .bind(doc)
    .bind(workspace)
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO document_change_batch_actors(batch_id,user_id,first_sequence,last_sequence) VALUES($1,$2,1,1)",
  )
  .bind(batch)
  .bind(user)
  .execute(&mut *tx)
  .await
  .unwrap();
  sqlx::query("SAVEPOINT duplicate_window")
    .execute(&mut *tx)
    .await
    .unwrap();
  let duplicate = sqlx::query(insert)
    .bind(Uuid::new_v4())
    .bind(doc)
    .bind(workspace)
    .execute(&mut *tx)
    .await
    .expect_err("one active window per document");
  assert_eq!(
    duplicate.as_database_error().and_then(|error| error.code()).as_deref(),
    Some("23505")
  );
  sqlx::query("ROLLBACK TO SAVEPOINT duplicate_window")
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("UPDATE document_change_batches SET sealed_at=now() WHERE id=$1")
    .bind(batch)
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query(insert)
    .bind(Uuid::new_v4())
    .bind(doc)
    .bind(workspace)
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("DELETE FROM docs WHERE id=$1")
    .bind(doc)
    .execute(&mut *tx)
    .await
    .unwrap();
  let batches: i64 = sqlx::query_scalar("SELECT count(*) FROM document_change_batches WHERE doc_id=$1")
    .bind(doc)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
  let actors: i64 = sqlx::query_scalar("SELECT count(*) FROM document_change_batch_actors WHERE batch_id=$1")
    .bind(batch)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
  assert_eq!(batches, 0);
  assert_eq!(actors, 0);
  tx.rollback().await.expect("remove isolated pending schema fixture");
}
