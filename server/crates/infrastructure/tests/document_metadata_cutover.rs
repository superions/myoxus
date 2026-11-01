// SPDX-License-Identifier: AGPL-3.0-or-later
//! Migration-level invariants for the document metadata consolidation target.
//!
//! These tests protect the model-first cut-over: canonical 1:1 metadata is
//! additive on `docs`, audience is many-valued, template state is not encoded as
//! `documentType=template`, and workspace roles accepted by the domain layer are
//! accepted by the database constraint as well.

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

use myoxus_application::document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService};
use myoxus_application::document_metadata_policy::DocumentMetadataPolicyService;
use myoxus_domain::entities::{DocumentMetadataPatch, DocumentWorkspaceSettings};
use myoxus_domain::repositories::RepositoryError;
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, DocumentMetadataRepository};
use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
use myoxus_infrastructure::document_metadata::{
  PgDocumentMetadataRepository, sync_document_default_language_from_locale,
};
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::redis::InMemoryRedisAdapter;

struct IsolatedTestConfigValidator;

impl myoxus_application::config_validation::StartupConfigValidator for IsolatedTestConfigValidator {
  fn validate(
    &self,
    _candidate: &myoxus_application::config_validation::PreparedConfigCandidate,
  ) -> Result<(), String> {
    Ok(())
  }
}

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

async fn seed_workspace(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
  let owner_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocMetaOwner') RETURNING id")
    .bind(format!("docmeta-owner-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .expect("insert owner");
  let member_id: Uuid = sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocMetaMember') RETURNING id")
    .bind(format!("docmeta-member-{}@test.invalid", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .expect("insert member");
  let workspace_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Doc Metadata Cutover') RETURNING id")
      .bind(owner_id)
      .fetch_one(pool)
      .await
      .expect("insert workspace");
  let doc_id: Uuid = sqlx::query_scalar(
    "INSERT INTO docs (workspace_id, title, created_by, updated_by) VALUES ($1, 'Doc Metadata Cutover', $2, $2) RETURNING id",
  )
  .bind(workspace_id)
  .bind(owner_id)
  .fetch_one(pool)
  .await
  .expect("insert doc");
  (owner_id, member_id, workspace_id, doc_id)
}

async fn cleanup_workspace(pool: &PgPool, owner_id: Uuid, member_id: Uuid, workspace_id: Uuid) {
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![owner_id, member_id])
    .execute(pool)
    .await
    .expect("cleanup users");
}

fn server_crates_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("infrastructure crate must live under server/crates")
    .to_path_buf()
}

fn collect_rust_sources(dir: &Path, files: &mut Vec<PathBuf>) {
  let entries = fs::read_dir(dir).unwrap_or_else(|err| panic!("read {}: {err}", dir.display()));
  for entry in entries {
    let entry = entry.expect("read dir entry");
    let path = entry.path();
    if path.is_dir() {
      collect_rust_sources(&path, files);
    } else if path.extension().is_some_and(|extension| extension == "rs") {
      files.push(path);
    }
  }
}

fn relative_to_repo(path: &Path) -> String {
  let crates_dir = server_crates_dir();
  path
    .strip_prefix(crates_dir.parent().expect("server directory"))
    .unwrap_or(path)
    .to_string_lossy()
    .replace('\\', "/")
}

#[tokio::test]
async fn inv_docmeta_schema01_target_tables_and_docs_columns_exist() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let migration_versions: Vec<i64> = sqlx::query_scalar(
    "SELECT version FROM _sqlx_migrations WHERE version IN (123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151) ORDER BY version",
  )
  .fetch_all(&pool)
  .await
  .expect("query migration versions");
  assert_eq!(
    migration_versions,
    vec![
      123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144,
      145, 146, 147, 148, 149, 150, 151
    ],
    "0123 target schema through 0151 document metadata cut-over migrations must be applied"
  );

  let required_columns = [
    "status_id",
    "document_type_id",
    "classification_id",
    "retention_policy_id",
    "language_id",
    "responsible_user_id",
    "document_number",
    "review_due_at",
    "valid_from",
    "valid_until",
    "journal_date",
    "current_version_id",
    "metadata_materialized_at",
    "metadata_updated_at",
    "metadata_updated_by",
    "metadata_revision",
    "audience_source",
  ];

  for column in required_columns {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'docs' AND column_name = $1)",
    )
    .bind(column)
    .fetch_one(&pool)
    .await
    .expect("query docs column");
    assert!(exists, "docs.{column} must exist as canonical metadata target");
  }

  for column in [
    "source_doc_id",
    "source_block_id",
    "source_start_offset",
    "source_end_offset",
    "source_kind",
  ] {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'calendar_event_source_links' AND column_name = $1)",
    )
    .bind(column)
    .fetch_one(&pool)
    .await
    .expect("query calendar source-link column");
    assert!(
      exists,
      "calendar_event_source_links.{column} must exist so event source anchors stay out of docs metadata"
    );
  }

  for column in ["default_status_id", "template_defaults"] {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'document_type_definition' AND column_name = $1)",
    )
    .bind(column)
    .fetch_one(&pool)
    .await
    .expect("query legacy document type column");
    assert!(
      !exists,
      "document_type_definition.{column} must be dropped; status defaults live in document_type_status_default and templates in document_template_state/registry"
    );
  }

  for column in ["default_template_profile_id", "overrides"] {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'document_workspace_settings' AND column_name = $1)",
    )
    .bind(column)
    .fetch_one(&pool)
    .await
    .expect("query legacy workspace document settings column");
    assert!(
      !exists,
      "document_workspace_settings.{column} must be dropped; workspace settings carry typed defaults only"
    );
  }

  for (table, constraint) in [
    (
      "organization_document_settings",
      "organization_document_settings_default_status_schema_fkey",
    ),
    (
      "document_workspace_settings",
      "document_workspace_settings_default_status_schema_fkey",
    ),
  ] {
    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM information_schema.table_constraints WHERE table_name = $1 AND constraint_name = $2)",
    )
    .bind(table)
    .bind(constraint)
    .fetch_one(&pool)
    .await
    .expect("query default status schema constraint");
    assert!(
      exists,
      "{table}.{constraint} must keep default_status_id tied to status_schema_id"
    );
  }

  let legacy_state_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_attribute_state')",
  )
  .fetch_one(&pool)
  .await
  .expect("query legacy attribute state table");
  assert!(
    !legacy_state_exists,
    "document_attribute_state must be dropped after canonical docs metadata cut-over"
  );

  let legacy_value_definition_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_attribute_value_definition')",
  )
  .fetch_one(&pool)
  .await
  .expect("query legacy attribute value definition table");
  assert!(
    !legacy_value_definition_exists,
    "document_attribute_value_definition must be dropped after typed reference catalogs own all value lists"
  );

  let legacy_attribute_definition_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_attribute_definition')",
  )
  .fetch_one(&pool)
  .await
  .expect("query legacy metadata field definition table");
  assert!(
    !legacy_attribute_definition_exists,
    "document_attribute_definition must be dropped after document_metadata_field_definition owns field policy"
  );

  let initial_sync_audit_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_initial_sync_audit')",
  )
  .fetch_one(&pool)
  .await
  .expect("query initial sync audit table");
  assert!(
    initial_sync_audit_exists,
    "document_initial_sync_audit must exist so first-sync provenance is a transactional server fact"
  );

  for (table, expected_min) in [
    ("document_classification_definition", 4_i64),
    ("document_retention_policy_definition", 4_i64),
    ("language_definition", 10_i64),
    ("document_audience_definition", 5_i64),
    ("document_metadata_field_definition", 18_i64),
  ] {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
      .fetch_one(&pool)
      .await
      .expect("count reference table");
    assert!(count >= expected_min, "{table} must be seeded, got {count}");
  }

  let public_label: String =
    sqlx::query_scalar("SELECT label FROM document_classification_definition WHERE key = 'public'")
      .fetch_one(&pool)
      .await
      .expect("public classification label");
  assert_eq!(public_label, "Öffentlich");

  let french_label: String = sqlx::query_scalar("SELECT label FROM language_definition WHERE key = 'fr'")
    .fetch_one(&pool)
    .await
    .expect("French language label");
  assert_eq!(french_label, "Français");

  let language_keys: Vec<String> = sqlx::query_scalar("SELECT key FROM language_definition ORDER BY sort_order, key")
    .fetch_all(&pool)
    .await
    .expect("language keys");
  assert_eq!(
    language_keys,
    vec![
      "en".to_string(),
      "de".to_string(),
      "fr".to_string(),
      "it".to_string(),
      "es".to_string(),
      "pl".to_string(),
      "uk".to_string(),
      "nl".to_string(),
      "pt-BR".to_string(),
      "el-GR".to_string()
    ],
    "language defaults must use the normalized active metadata language set"
  );
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('i18n.default_locale', to_jsonb('en'::text)) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("reset runtime locale for deterministic default-language invariant");
  let default_language_key: String =
    sqlx::query_scalar("SELECT key FROM language_definition WHERE id = document_metadata_default_language_id()")
      .fetch_one(&pool)
      .await
      .expect("server default document language");
  assert_eq!(
    default_language_key, "en",
    "document language fallback must follow i18n.default_locale instead of a hard-coded German seed"
  );
  let default_profile: (String, String, String, String, String, String, Vec<String>) = sqlx::query_as(
    "SELECT status_schema_key, default_status_key, default_document_type_key, \
            default_classification_key, default_retention_policy_key, default_language_key, \
            default_audience_keys \
     FROM document_metadata_default_profile()",
  )
  .fetch_one(&pool)
  .await
  .expect("document metadata default profile");
  assert_eq!(
    default_profile,
    (
      "simple".to_string(),
      "in_progress".to_string(),
      "documentation".to_string(),
      "public".to_string(),
      "standard".to_string(),
      "en".to_string(),
      vec!["internal".to_string()]
    ),
    "the server default profile contract must expose the complete semantic default key set"
  );

  let status_policy: (String, String, String, String) = sqlx::query_as(
    "SELECT storage_field, inheritance_mode, source_column, mutation_route \
     FROM document_metadata_field_definition WHERE key = 'status'",
  )
  .fetch_one(&pool)
  .await
  .expect("status metadata field policy");
  assert_eq!(
    status_policy,
    (
      "status_id".to_string(),
      "inherited".to_string(),
      "status_source".to_string(),
      "status_transition".to_string()
    ),
    "status must be routed through transition service and canonical docs.status_id"
  );

  let invalid_org_role = sqlx::query(
    "UPDATE document_metadata_field_definition SET organization_edit_role = 'document_editor' WHERE key = 'language'",
  )
  .execute(&pool)
  .await;
  assert!(
    invalid_org_role.is_err(),
    "organization field policy must reject document-scoped edit roles"
  );
  let invalid_storage_area =
    sqlx::query("UPDATE document_metadata_field_definition SET storage_area = 'presentation' WHERE key = 'language'")
      .execute(&pool)
      .await;
  assert!(
    invalid_storage_area.is_err(),
    "field matrix must reject transitional shorthand storage_area values"
  );
  let invalid_projection_visibility = sqlx::query(
    "UPDATE document_metadata_field_definition SET projection_visibility = 'native' WHERE key = 'language'",
  )
  .execute(&pool)
  .await;
  assert!(
    invalid_projection_visibility.is_err(),
    "field matrix must reject transitional shorthand projection visibility values"
  );

  for (key, expected) in [
    (
      "documentType",
      ("organization_admin", "workspace_admin", "document_editor"),
    ),
    (
      "classification",
      ("organization_admin", "workspace_admin", "document_editor"),
    ),
    ("language", ("organization_admin", "workspace_admin", "document_editor")),
    (
      "documentNumber",
      ("organization_admin", "workspace_admin", "document_editor"),
    ),
    (
      "validFrom",
      ("organization_admin", "workspace_admin", "document_editor"),
    ),
    (
      "responsible",
      ("organization_admin", "workspace_admin", "responsible_user"),
    ),
    (
      "reviewDueAt",
      ("organization_admin", "workspace_admin", "responsible_user"),
    ),
    (
      "validUntil",
      ("organization_admin", "workspace_admin", "responsible_user"),
    ),
    (
      "retentionPolicy",
      ("organization_admin", "workspace_admin", "workspace_admin"),
    ),
    ("status", ("system_only", "system_only", "system_only")),
    ("version", ("system_only", "system_only", "system_only")),
  ] {
    let roles: (String, String, String) = sqlx::query_as(
      "SELECT organization_edit_role, workspace_edit_role, document_edit_role \
       FROM document_metadata_field_definition WHERE key = $1",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("field edit-role row");
    assert_eq!(
      (roles.0.as_str(), roles.1.as_str(), roles.2.as_str()),
      expected,
      "{key} must use the explicit CUTOVER-06 editable_by mapping"
    );
  }

  for table in [
    "document_metadata_global_epoch",
    "organization_document_metadata_epoch",
    "workspace_document_metadata_epoch",
    "document_presentation_state",
    "document_integration_state",
  ] {
    let exists: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)")
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("query epoch table");
    assert!(exists, "{table} must exist for projection invalidation epochs");
  }

  for function_name in [
    "document_metadata_effective_organization_id",
    "document_metadata_default_profile",
    "document_metadata_rematerialize_workspace_defaults",
    "document_metadata_seed_organization_defaults",
    "document_metadata_default_language_id",
    "document_metadata_resolve_responsible_fallback",
    "document_metadata_is_valid_responsible_user",
    "document_metadata_rematerialize_workspace_settings_trigger",
    "document_metadata_rematerialize_organization_settings_trigger",
    "document_metadata_rematerialize_workspace_owner_trigger",
    "document_metadata_rematerialize_workspace_membership_trigger",
    "document_metadata_can_edit_organization_default",
    "document_metadata_guard_organization_settings_policy",
  ] {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = $1)")
      .bind(function_name)
      .fetch_one(&pool)
      .await
      .expect("query rematerializer function");
    assert!(exists, "{function_name} must exist for default rematerialization");
  }

  let legacy_reconcile_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'document_metadata_reconcile_legacy_responsible_principals')",
  )
  .fetch_one(&pool)
  .await
  .expect("query legacy reconcile function");
  assert!(
    !legacy_reconcile_exists,
    "document_metadata_reconcile_legacy_responsible_principals must be dropped with document_attribute_state"
  );

  let trigger_exists: bool = sqlx::query_scalar(
    "SELECT EXISTS( \
       SELECT 1 \
       FROM pg_trigger \
       WHERE tgname = 'trg_document_metadata_seed_organization_defaults' \
         AND NOT tgisinternal \
     )",
  )
  .fetch_one(&pool)
  .await
  .expect("query organization default trigger");
  assert!(
    trigger_exists,
    "new organizations must receive the document metadata default profile automatically"
  );

  for key in [
    "templateState",
    "primaryMode",
    "pageWidth",
    "edgelessColorTheme",
    "integrationType",
  ] {
    let field_policy: (String, String, String, String, String, String) = sqlx::query_as(
      "SELECT storage_area, mutation_route, projection_visibility, \
              organization_edit_role, workspace_edit_role, document_edit_role \
       FROM document_metadata_field_definition WHERE key = $1",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("subsystem field policy");
    assert_eq!(
      field_policy,
      match key {
        "templateState" => (
          "template_state".to_string(),
          "template_state".to_string(),
          "both".to_string(),
          "organization_admin".to_string(),
          "workspace_admin".to_string(),
          "document_editor".to_string(),
        ),
        "integrationType" => (
          "integration_subsystem".to_string(),
          "integration_subsystem".to_string(),
          "both".to_string(),
          "organization_admin".to_string(),
          "workspace_admin".to_string(),
          "document_editor".to_string(),
        ),
        _ => (
          "presentation_setting".to_string(),
          "presentation_setting".to_string(),
          "both".to_string(),
          "organization_admin".to_string(),
          "workspace_admin".to_string(),
          "document_editor".to_string(),
        ),
      },
      "{key} must be an explicit native subsystem field, not a local-property compatibility path"
    );
  }

  for (key, expected) in [
    (
      "audience",
      (
        "relation_table",
        "relation_inherited",
        "audience_source",
        "document_metadata",
        "both",
      ),
    ),
    (
      "metadataRevision",
      ("system_fact", "system_readonly", "", "readonly", "myoxus_native"),
    ),
    (
      "templateState",
      ("template_state", "specialized_subsystem", "", "template_state", "both"),
    ),
    (
      "journalDate",
      (
        "journal_calendar_subsystem",
        "system_readonly",
        "",
        "journal_calendar",
        "both",
      ),
    ),
  ] {
    let matrix: (String, String, Option<String>, String, String) = sqlx::query_as(
      "SELECT storage_area, inheritance_mode, source_column, mutation_route, projection_visibility \
       FROM document_metadata_field_definition WHERE key = $1",
    )
    .bind(key)
    .fetch_one(&pool)
    .await
    .expect("field matrix row");
    assert_eq!(
      (
        matrix.0.as_str(),
        matrix.1.as_str(),
        matrix.2.as_deref().unwrap_or(""),
        matrix.3.as_str(),
        matrix.4.as_str()
      ),
      expected,
      "{key} must use the canonical field-matrix vocabulary"
    );
  }

  let global_epochs: Vec<String> =
    sqlx::query_scalar("SELECT epoch_name FROM document_metadata_global_epoch ORDER BY epoch_name")
      .fetch_all(&pool)
      .await
      .expect("query global epoch names");
  assert_eq!(
    global_epochs,
    vec!["field_definition".to_string(), "reference_values".to_string()],
    "global projection epochs must be named, not one broad id=true counter"
  );

  for (table, id_column, expected_names) in [
    (
      "organization_document_metadata_epoch",
      "organization_id",
      vec!["defaults", "policy"],
    ),
    ("workspace_document_metadata_epoch", "workspace_id", vec!["defaults"]),
  ] {
    let columns: Vec<String> = sqlx::query_scalar(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(&pool)
    .await
    .expect("query epoch table columns");
    assert!(
      columns.contains(&"epoch_name".to_string())
        && columns.contains(&"revision".to_string())
        && columns.contains(&"updated_by".to_string())
        && columns.contains(&id_column.to_string()),
      "{table} must use normalized named revisions with actor provenance"
    );

    let distinct_names: Vec<String> =
      sqlx::query_scalar(&format!("SELECT DISTINCT epoch_name FROM {table} ORDER BY epoch_name"))
        .fetch_all(&pool)
        .await
        .expect("query scoped epoch names");
    if !distinct_names.is_empty() {
      assert_eq!(
        distinct_names,
        expected_names.into_iter().map(ToString::to_string).collect::<Vec<_>>(),
        "{table} epoch names drifted"
      );
    }
  }
}

#[test]
fn inv_docmeta_source02_docs_insert_paths_are_explicitly_inventoried() {
  let mut sources = Vec::new();
  collect_rust_sources(&server_crates_dir(), &mut sources);

  let mut actual = Vec::new();
  for source in sources {
    let rel = relative_to_repo(&source);
    if rel.contains("/tests/") || rel.ends_with("_test.rs") {
      continue;
    }
    let content = fs::read_to_string(&source).unwrap_or_else(|err| panic!("read {}: {err}", source.display()));
    let count = content.matches("INSERT INTO docs").count();
    for _ in 0..count {
      actual.push(rel.clone());
    }
  }
  actual.sort();

  let mut expected = vec![
    "crates/infrastructure/src/document_metadata/initial_sync_audit.rs",
    "crates/infrastructure/src/doc/mod.rs",
    "crates/infrastructure/src/doc/mod.rs",
    "crates/infrastructure/src/doc/mod.rs",
    "crates/infrastructure/src/doc/mod.rs",
    "crates/infrastructure/src/workspace/mod.rs",
    "crates/infrastructure/src/workspace/mod.rs",
    "crates/infrastructure/src/team/mod.rs",
  ];
  expected.sort();

  assert_eq!(
    actual, expected,
    "Every new docs insert path must be reviewed as either an explicit create/root-doc path or routed through initial-sync provenance. Update this inventory only with a TODO/documented reason."
  );
}

#[tokio::test]
async fn inv_docmeta_schema01b_i18n_default_locale_drives_organization_language_defaults() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('i18n.default_locale', to_jsonb('en'::text)) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("set runtime locale to default");
  let default_org_key = format!("docmeta-locale-default-{}", Uuid::new_v4());
  let default_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'Default Locale Org', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(&default_org_key)
  .fetch_one(&pool)
  .await
  .expect("insert default locale organization");
  let default_language: String = sqlx::query_scalar(
    "SELECT lang.key \
     FROM organization_document_settings settings \
     JOIN language_definition lang ON lang.id = settings.default_language_id \
     WHERE settings.organization_id = $1",
  )
  .bind(default_org_id)
  .fetch_one(&pool)
  .await
  .expect("read default org language");
  assert_eq!(
    default_language, "en",
    "organization defaults must follow i18n.default_locale=en without relying on stale test DB state"
  );

  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('i18n.default_locale', to_jsonb('fr'::text)) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("set runtime locale");

  let runtime_org_key = format!("docmeta-locale-{}", Uuid::new_v4());
  let runtime_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'Runtime Locale Org', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(&runtime_org_key)
  .fetch_one(&pool)
  .await
  .expect("insert runtime locale organization");
  let runtime_language: String = sqlx::query_scalar(
    "SELECT lang.key \
     FROM organization_document_settings settings \
     JOIN language_definition lang ON lang.id = settings.default_language_id \
     WHERE settings.organization_id = $1",
  )
  .bind(runtime_org_id)
  .fetch_one(&pool)
  .await
  .expect("read runtime org default language");
  assert_eq!(
    runtime_language, "fr",
    "new organization trigger must consume app_configs i18n.default_locale"
  );

  let admin_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name, is_admin) VALUES ($1, 'Locale Admin', true) RETURNING id")
      .bind(format!("docmeta-locale-admin-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert admin");
  let explicit_org_key = format!("docmeta-locale-explicit-{}", Uuid::new_v4());
  let explicit_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'Explicit Locale Org', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(&explicit_org_key)
  .fetch_one(&pool)
  .await
  .expect("insert explicit locale organization");
  sqlx::query(
    "UPDATE organization_document_settings \
     SET default_language_id = (SELECT id FROM language_definition WHERE key = 'de'), updated_by = $2 \
     WHERE organization_id = $1",
  )
  .bind(explicit_org_id)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("set explicit admin language default");
  sqlx::query("SELECT document_metadata_seed_organization_defaults($1)")
    .bind(explicit_org_id)
    .execute(&pool)
    .await
    .expect("re-run default seed against explicit organization settings");
  let explicit_after_seed: String = sqlx::query_scalar(
    "SELECT lang.key \
     FROM organization_document_settings settings \
     JOIN language_definition lang ON lang.id = settings.default_language_id \
     WHERE settings.organization_id = $1",
  )
  .bind(explicit_org_id)
  .fetch_one(&pool)
  .await
  .expect("read explicit org language after seed rerun");
  assert_eq!(
    explicit_after_seed, "de",
    "default seeding must be idempotent and must not overwrite explicit organization defaults"
  );

  let stats = sync_document_default_language_from_locale(&pool, "pt-BR", &IsolatedTestConfigValidator)
    .await
    .expect("sync server i18n locale");
  assert_eq!(stats.configured_locale, "pt-BR");
  assert_eq!(stats.resolved_language_key, "pt-BR");

  let explicit_after: String = sqlx::query_scalar(
    "SELECT lang.key \
     FROM organization_document_settings settings \
     JOIN language_definition lang ON lang.id = settings.default_language_id \
     WHERE settings.organization_id = $1",
  )
  .bind(explicit_org_id)
  .fetch_one(&pool)
  .await
  .expect("read explicit org after sync");
  assert_eq!(
    explicit_after, "de",
    "server startup sync must not overwrite admin-authored organization language defaults"
  );

  let synced_org_key = format!("docmeta-locale-synced-{}", Uuid::new_v4());
  let synced_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'Synced Locale Org', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(&synced_org_key)
  .fetch_one(&pool)
  .await
  .expect("insert synced locale organization");
  let synced_language: String = sqlx::query_scalar(
    "SELECT lang.key \
     FROM organization_document_settings settings \
     JOIN language_definition lang ON lang.id = settings.default_language_id \
     WHERE settings.organization_id = $1",
  )
  .bind(synced_org_id)
  .fetch_one(&pool)
  .await
  .expect("read synced org language");
  assert_eq!(
    synced_language, "pt-BR",
    "organizations created after startup sync must inherit the configured server locale"
  );
}

#[tokio::test]
async fn inv_docmeta_schema02_many_valued_audience_template_guard_and_revision() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Manager', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&pool)
    .await
    .expect("Manager workspace role must satisfy DB check");
    sqlx::query("UPDATE workspace_memberships SET role = 'Commenter' WHERE workspace_id = $1 AND user_id = $2")
      .bind(workspace_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("Commenter workspace role must satisfy DB check");

    let audience_ids: Vec<Uuid> = sqlx::query_scalar(
      "SELECT id FROM document_audience_definition WHERE key IN ('internal', 'management') ORDER BY key",
    )
    .fetch_all(&pool)
    .await
    .expect("select audiences");
    assert_eq!(audience_ids.len(), 2, "test requires two seeded audiences");

    sqlx::query("DELETE FROM doc_audience_assignment WHERE doc_id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("clear default audience before relation cardinality check");

    for audience_id in &audience_ids {
      sqlx::query("INSERT INTO doc_audience_assignment (doc_id, audience_id, assigned_by) VALUES ($1, $2, $3)")
        .bind(doc_id)
        .bind(*audience_id)
        .bind(owner_id)
        .execute(&pool)
        .await
        .expect("insert audience assignment");
    }
    let assigned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_audience_assignment WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("count assignments");
    assert_eq!(assigned, 2, "audience must be a relation, not a single docs FK");

    let template_type_id: Uuid = sqlx::query_scalar("SELECT id FROM document_type_definition WHERE key = 'template'")
      .fetch_one(&pool)
      .await
      .expect("select template document type");
    let template_update = sqlx::query("UPDATE docs SET document_type_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(template_type_id)
      .execute(&pool)
      .await;
    assert!(
      template_update.is_err(),
      "canonical docs.document_type_id must reject documentType=template"
    );

    let classification_id: Uuid =
      sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = 'internal'")
        .fetch_one(&pool)
        .await
        .expect("select classification");
    let before: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("metadata revision before");
    sqlx::query("UPDATE docs SET classification_id = $2, metadata_updated_by = $3 WHERE id = $1")
      .bind(doc_id)
      .bind(classification_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("update canonical metadata");
    let (after, metadata_updated_at, metadata_updated_by, updated_by): (
      i64,
      Option<chrono::DateTime<chrono::Utc>>,
      Option<Uuid>,
      Option<Uuid>,
    ) = sqlx::query_as(
      "SELECT metadata_revision, metadata_updated_at, metadata_updated_by, updated_by FROM docs WHERE id = $1",
    )
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("metadata revision after");
    assert_eq!(after, before + 1, "metadata updates must bump metadata_revision");
    assert!(
      metadata_updated_at.is_some(),
      "metadata update timestamp must be materialized"
    );
    assert_eq!(
      metadata_updated_by,
      Some(member_id),
      "metadata updater must use the explicit metadata actor, not docs.updated_by"
    );
    assert_eq!(
      updated_by,
      Some(owner_id),
      "metadata-only updates must not mutate content/system updated_by"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02b_projection_version_uses_named_epochs() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataRepository::new(pool.clone());
    let myoxus_org_id: Uuid =
      sqlx::query_scalar("SELECT id FROM organization WHERE key = 'myoxus' ORDER BY created_at, id LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("select default organization");

    let initial = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("initial projection version")
      .expect("document has projection version");
    assert!(
      initial.starts_with("contract-v3:doc:"),
      "projection version must use the normalized epoch contract: {initial}"
    );
    for segment in [
      "global:field_definition=",
      ";reference_values=",
      ":org:",
      ":policy=",
      ";defaults=",
      ":workspace:defaults=",
    ] {
      assert!(
        initial.contains(segment),
        "projection version must include {segment}, got {initial}"
      );
    }

    let metadata_revision_before: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("metadata revision before epoch bumps");

    sqlx::query("UPDATE document_metadata_field_definition SET updated_by = $1 WHERE key = 'language'")
      .bind(owner_id)
      .execute(&pool)
      .await
      .expect("field-definition writes must bump the global field-definition epoch");
    let after_field_definition = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("field-definition projection version")
      .expect("document has projection version");
    assert_ne!(
      after_field_definition, initial,
      "field-definition writes must change the projection cache key without touching docs.metadata_revision"
    );

    sqlx::query("UPDATE document_classification_definition SET updated_by = $1 WHERE key = 'public'")
      .bind(owner_id)
      .execute(&pool)
      .await
      .expect("reference-value writes must bump the global reference-values epoch");
    let after_reference_values = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("reference-values projection version")
      .expect("document has projection version");
    assert_ne!(
      after_reference_values, after_field_definition,
      "reference-value writes must change the projection cache key without touching docs.metadata_revision"
    );

    sqlx::query(
      "UPDATE organization_document_metadata_policy SET updated_by = $1 WHERE organization_id = $2 AND field_key = 'language'",
    )
    .bind(member_id)
    .bind(myoxus_org_id)
    .execute(&pool)
    .await
    .expect("organization policy writes must bump the organization policy epoch");
    let after_org_policy = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("organization-policy projection version")
      .expect("document has projection version");
    assert_ne!(
      after_org_policy, after_reference_values,
      "organization policy writes must change the projection cache key without touching docs.metadata_revision"
    );

    sqlx::query("UPDATE organization_document_settings SET updated_by = $1 WHERE organization_id = $2")
      .bind(member_id)
      .bind(myoxus_org_id)
      .execute(&pool)
      .await
      .expect("organization default writes must bump the organization defaults epoch");
    let after_org_defaults = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("organization-defaults projection version")
      .expect("document has projection version");
    assert_ne!(
      after_org_defaults, after_org_policy,
      "organization default writes must change the projection cache key without touching docs.metadata_revision"
    );

    sqlx::query(
      "INSERT INTO document_workspace_settings (workspace_id, updated_by) \
       VALUES ($1, $2) \
       ON CONFLICT (workspace_id) DO UPDATE SET updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&pool)
    .await
    .expect("workspace default writes must bump the workspace defaults epoch");

    let after_all = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("final projection version")
      .expect("document has projection version");
    assert_ne!(
      after_all, after_org_defaults,
      "workspace default writes must change the projection cache key without touching docs.metadata_revision"
    );

    let metadata_revision_after: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("metadata revision after epoch bumps");
    assert_eq!(
      metadata_revision_after, metadata_revision_before,
      "definition/default/policy epoch bumps must invalidate cache without mutating docs.metadata_revision"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02f_every_cross_table_projection_fact_advances_freshness() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataRepository::new(pool.clone());
    let mut version = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("initial projection version")
      .expect("document has projection version");

    sqlx::query("UPDATE docs SET updated_at = updated_at + interval '1 second', updated_by = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("update projected system facts");
    let after_system = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("system-fact projection version")
      .expect("document has projection version");
    assert_ne!(after_system, version, "updated_at/updated_by must advance freshness");
    let (_, projection) = repository
      .get_projection_versioned(doc_id, workspace_id)
      .await
      .expect("versioned system projection")
      .expect("document has versioned projection");
    assert_eq!(projection.system.updated_by, Some(member_id));
    let current_revision = projection.metadata_revision;
    version = after_system;

    let audience_id: Uuid =
      sqlx::query_scalar("SELECT id FROM document_audience_definition WHERE key = 'customer' AND is_active")
        .fetch_one(&pool)
        .await
        .expect("select audience");
    repository
      .apply_patch(
        doc_id,
        owner_id,
        &DocumentMetadataPatch {
          expected_metadata_revision: Some(current_revision),
          audience_ids: Some(vec![audience_id]),
          ..DocumentMetadataPatch::default()
        },
      )
      .await
      .expect("canonical audience writer updates relation and revision atomically");
    let after_audience = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("audience projection version")
      .expect("document has projection version");
    assert_ne!(
      after_audience, version,
      "audience relation writes must advance freshness"
    );
    version = after_audience;

    let history_id: i64 =
      sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
        .bind(doc_id)
        .bind(workspace_id)
        .bind(Vec::<u8>::new())
        .fetch_one(&pool)
        .await
        .expect("insert version history");
    let version_id: Uuid = sqlx::query_scalar(
      "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by) VALUES ($1, $2, $3, 'Initial label', $4) RETURNING id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(history_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert named version");
    sqlx::query("UPDATE docs SET current_version_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(version_id)
      .execute(&pool)
      .await
      .expect("select current version head");
    let after_head = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("version-head projection version")
      .expect("document has projection version");
    assert_ne!(after_head, version, "version head changes must advance freshness");

    sqlx::query("UPDATE document_version SET label = 'Renamed label' WHERE id = $1")
      .bind(version_id)
      .execute(&pool)
      .await
      .expect("rename rendered version reference");
    let after_label = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("version-label projection version")
      .expect("document has projection version");
    assert_ne!(after_label, after_head, "current version labels must advance freshness");
    let (atomic_version, projection) = repository
      .get_projection_versioned(doc_id, workspace_id)
      .await
      .expect("versioned projection")
      .expect("document has versioned projection");
    assert_eq!(
      atomic_version, after_label,
      "version and payload must share one snapshot"
    );
    assert!(
      projection
        .fields
        .iter()
        .find(|field| field.key == "version")
        .and_then(|field| field.reference.as_ref())
        .is_some_and(|reference| reference.label == "Renamed label"),
      "versioned projection must contain the label covered by its cache key"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02g_cross_instance_warm_projection_uses_the_new_version() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
    let redis = Arc::new(InMemoryRedisAdapter::new(format!(
      "projection-cross-instance-{}",
      Uuid::new_v4()
    )));
    let cache_a = Arc::new(DocCache::new(redis.clone(), "myoxus", &RedisDocCacheConfig::default()));
    let cache_b = Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()));
    let service_a = DocumentMetadataService::new(repo.clone()).with_projection_cache(cache_a);
    let service_b = DocumentMetadataService::new(repo).with_projection_cache(cache_b);

    let initial = service_a
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .expect("first instance warms the shared projection cache");
    assert_eq!(initial.system.updated_by, Some(owner_id));

    sqlx::query("UPDATE docs SET updated_at = updated_at + interval '1 second', updated_by = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("cross-instance writer updates projected system facts");

    let second_instance = service_b
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .expect("second instance resolves the current projection version");
    assert_ne!(second_instance.projection_version, initial.projection_version);
    assert_eq!(
      second_instance.system.updated_by,
      Some(member_id),
      "a warm old key must not hide the cross-instance write"
    );
    let first_instance_again = service_a
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .expect("first instance observes the shared current key");
    assert_eq!(first_instance_again.system.updated_by, Some(member_id));
    assert_eq!(
      first_instance_again.projection_version,
      second_instance.projection_version
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_wlp08_document_list_revision_tracks_projected_facts_without_body_churn() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repo = Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
    let redis = Arc::new(InMemoryRedisAdapter::new(format!("wlp08-index-{}", Uuid::new_v4())));
    let cache_a = Arc::new(DocCache::new(redis.clone(), "myoxus", &RedisDocCacheConfig::default()));
    let cache_b = Arc::new(DocCache::new(redis, "myoxus", &RedisDocCacheConfig::default()));
    let service_a = DocumentMetadataPolicyService::new(repo.clone()).with_index_cache(cache_a);
    let service_b = DocumentMetadataPolicyService::new(repo.clone()).with_index_cache(cache_b);

    let initial_version = repo
      .metadata_index_version(workspace_id)
      .await
      .expect("initial list revision");
    let initial_rows = service_a
      .list_metadata_index(workspace_id)
      .await
      .expect("first instance warms the list index");
    assert_eq!(initial_rows.len(), 1);

    sqlx::query("UPDATE docs SET title = title || ' body-only title change' WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("change a non-index document fact");
    assert_eq!(
      repo
        .metadata_index_version(workspace_id)
        .await
        .expect("revision after unrelated edit"),
      initial_version,
      "non-index document changes must not churn the workspace list revision"
    );

    let external_id = format!("wlp08-{}", Uuid::new_v4().simple());
    sqlx::query("UPDATE docs SET external_id = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(&external_id)
      .execute(&pool)
      .await
      .expect("change external identity");
    let external_version = repo
      .metadata_index_version(workspace_id)
      .await
      .expect("revision after identity change");
    assert_ne!(external_version, initial_version);
    let identity_rows = service_b
      .list_metadata_index(workspace_id)
      .await
      .expect("second instance reads the new identity revision");
    assert_eq!(identity_rows[0].external_id, external_id);

    let journal_date = chrono::NaiveDate::from_ymd_opt(2026, 9, 24).expect("valid date");
    sqlx::query("UPDATE docs SET journal_date = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(journal_date)
      .execute(&pool)
      .await
      .expect("change projected metadata");
    let metadata_rows = service_a
      .list_metadata_index(workspace_id)
      .await
      .expect("first instance leaves its old versioned value behind");
    assert_eq!(metadata_rows[0].journal_date, Some(journal_date));

    let history_id: i64 =
      sqlx::query_scalar("INSERT INTO doc_histories (doc_id, workspace_id, snapshot) VALUES ($1, $2, $3) RETURNING id")
        .bind(doc_id)
        .bind(workspace_id)
        .bind(Vec::<u8>::new())
        .fetch_one(&pool)
        .await
        .expect("insert history for list-head revision");
    let version_id: Uuid = sqlx::query_scalar(
      "INSERT INTO document_version (doc_id, workspace_id, doc_history_id, label, created_by) VALUES ($1, $2, $3, 'WLP-08', $4) RETURNING id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(history_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert named version for list head");
    sqlx::query("UPDATE docs SET current_version_id = $2, dirty_since_current_version = true WHERE id = $1")
      .bind(doc_id)
      .bind(version_id)
      .execute(&pool)
      .await
      .expect("change projected version head and dirty state");
    let version_rows = service_b
      .list_metadata_index(workspace_id)
      .await
      .expect("version-head revision is visible across instances");
    assert_eq!(version_rows[0].current_version_id, Some(version_id));
    assert!(version_rows[0].dirty_since_current_version);

    sqlx::query(
      "INSERT INTO document_template_state (doc_id, state, metadata) VALUES ($1, 'managed', '{\"origin\":\"custom\"}')",
    )
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("insert projected template state");
    sqlx::query("INSERT INTO document_integration_state (doc_id, integration_type) VALUES ($1, 'readwise')")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("insert projected integration state");
    let specialized_rows = service_a
      .list_metadata_index(workspace_id)
      .await
      .expect("specialized subsystem revision is visible across instances");
    assert_eq!(specialized_rows[0].template_state.as_deref(), Some("managed"));
    assert_eq!(specialized_rows[0].template_origin.as_deref(), Some("custom"));
    assert_eq!(specialized_rows[0].integration_type.as_deref(), Some("readwise"));

    sqlx::query(
      "INSERT INTO document_presentation_state (doc_id, primary_mode, page_width) VALUES ($1, 'edgeless', 'fullWidth')",
    )
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("insert projected subsystem state");
    let subsystem_rows = service_b
      .list_metadata_index(workspace_id)
      .await
      .expect("subsystem revision is visible across instances");
    assert_eq!(subsystem_rows[0].primary_mode.as_deref(), Some("edgeless"));
    assert_eq!(subsystem_rows[0].page_width.as_deref(), Some("fullWidth"));

    let before_noop = repo
      .metadata_index_version(workspace_id)
      .await
      .expect("revision before no-op subsystem update");
    sqlx::query("UPDATE document_presentation_state SET page_width = page_width WHERE doc_id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("run no-op projected-field update");
    assert_eq!(
      repo
        .metadata_index_version(workspace_id)
        .await
        .expect("revision after no-op subsystem update"),
      before_noop,
      "no-op writes must not bump the list revision"
    );

    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("trash document");
    assert!(
      service_a
        .list_metadata_index(workspace_id)
        .await
        .expect("trashed inventory loads")
        .is_empty()
    );
    sqlx::query("UPDATE docs SET deleted_at = NULL WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("restore document");
    assert_eq!(
      service_b
        .list_metadata_index(workspace_id)
        .await
        .expect("restored inventory loads")
        .len(),
      1
    );

    sqlx::query("DELETE FROM docs WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("permanently delete document");
    assert!(
      service_a
        .list_metadata_index(workspace_id)
        .await
        .expect("deleted inventory loads")
        .is_empty()
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02d_journal_date_bumps_projection_freshness_without_content_update() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataRepository::new(pool.clone());
    let before_projection_version = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("projection version before journal update")
      .expect("document has projection version before journal update");
    let (before_revision, before_updated_at): (i64, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT metadata_revision, updated_at FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("read head before journal update");

    let journal_date = chrono::NaiveDate::from_ymd_opt(2026, 5, 26).expect("valid test date");
    sqlx::query("UPDATE docs SET journal_date = $2, metadata_updated_by = $3 WHERE id = $1")
      .bind(doc_id)
      .bind(journal_date)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("journal subsystem stores the daily-doc anchor on docs");

    let (after_revision, after_updated_at): (i64, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT metadata_revision, updated_at FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("read head after journal update");
    assert_eq!(
      after_revision,
      before_revision + 1,
      "journal_date changes are visible metadata changes and must bump metadata_revision"
    );
    assert_eq!(
      after_updated_at, before_updated_at,
      "journal_date is metadata/subsystem state and must not touch content updated_at"
    );

    let after_projection_version = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("projection version after journal update")
      .expect("document has projection version after journal update");
    assert_ne!(
      after_projection_version, before_projection_version,
      "journal daily-doc changes must change projectionVersion through metadata_revision"
    );

    let projection = repository
      .get_projection(doc_id, workspace_id)
      .await
      .expect("load native projection after journal update")
      .expect("document metadata projection exists");
    assert_eq!(
      projection.journal.journal_date,
      Some(journal_date),
      "documentMetadata.journal must expose the canonical daily-doc anchor"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02e_projection_cache_excludes_user_display_data() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataRepository::new(pool.clone());
    let before_projection_version = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("projection version before user display update")
      .expect("document has projection version before user display update");

    sqlx::query("UPDATE users SET name = $2, email = $3 WHERE id = $1")
      .bind(owner_id)
      .bind("DocMetaOwner Renamed For Cache Guard")
      .bind(format!("docmeta-owner-renamed-{}@test.invalid", Uuid::new_v4()))
      .execute(&pool)
      .await
      .expect("update user display data");

    let after_projection_version = repository
      .projection_version(doc_id, workspace_id)
      .await
      .expect("projection version after user display update")
      .expect("document has projection version after user display update");
    assert_eq!(
      after_projection_version, before_projection_version,
      "user display changes must not enter the metadata projection cache key unless a dedicated user epoch is added"
    );

    let projection = repository
      .get_projection(doc_id, workspace_id)
      .await
      .expect("load projection after user display update")
      .expect("document metadata projection exists");
    let serialized = serde_json::to_string(&projection).expect("serialize projection");
    assert!(
      serialized.contains(&owner_id.to_string()),
      "system facts should keep user IDs for deterministic client-side identity resolution: {serialized}"
    );
    assert!(
      !serialized.contains("DocMetaOwner Renamed For Cache Guard") && !serialized.contains("@test.invalid"),
      "cached document metadata projection must not include user display names or emails: {serialized}"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema02c_userspace_rows_are_not_document_metadata() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let owner_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocMetaUserspaceOwner') RETURNING id")
      .bind(format!("docmeta-userspace-owner-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert owner");
  let userspace_doc_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO docs (id, userspace_owner_id, title, created_by, updated_by) VALUES ($1, $2, 'User DB Row', $2, $2)",
  )
  .bind(userspace_doc_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("insert userspace doc");

  let repository = PgDocumentMetadataRepository::new(pool.clone());
  let result = async {
    assert_eq!(
      repository
        .workspace_id_for_document(userspace_doc_id)
        .await
        .expect("workspace lookup"),
      None,
      "userspace/account-setting docs must not resolve to documentMetadata workspace scope"
    );

    let write_result = repository
      .apply_patch(
        userspace_doc_id,
        owner_id,
        &DocumentMetadataPatch {
          document_number: Some(Some("MUST-NOT-WRITE".to_string())),
          ..DocumentMetadataPatch::default()
        },
      )
      .await;
    assert!(
      matches!(&write_result, Err(RepositoryError::NotFound("document metadata"))),
      "userspace/account-setting docs must be rejected before metadata mutation: {write_result:?}"
    );

    let document_number: Option<String> = sqlx::query_scalar("SELECT document_number FROM docs WHERE id = $1")
      .bind(userspace_doc_id)
      .fetch_one(&pool)
      .await
      .expect("read userspace doc");
    assert_eq!(
      document_number, None,
      "rejected userspace metadata writes must not mutate canonical docs columns"
    );
  };

  result.await;
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(userspace_doc_id)
    .execute(&pool)
    .await
    .expect("cleanup userspace doc");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("cleanup owner");
}

#[test]
fn inv_docmeta_schema03_no_productive_legacy_attribute_storage_access() {
  let crates_dir = server_crates_dir();
  let mut files = Vec::new();
  for crate_name in ["api", "application", "domain", "infrastructure", "worker"] {
    collect_rust_sources(&crates_dir.join(crate_name).join("src"), &mut files);
  }

  let forbidden = [
    "FROM document_attribute_state",
    "JOIN document_attribute_state",
    "INSERT INTO document_attribute_state",
    "UPDATE document_attribute_state",
    "DELETE FROM document_attribute_state",
    "FROM document_attribute_value_definition",
    "JOIN document_attribute_value_definition",
    "INSERT INTO document_attribute_value_definition",
    "UPDATE document_attribute_value_definition",
    "DELETE FROM document_attribute_value_definition",
    "FROM document_attribute_definition",
    "JOIN document_attribute_definition",
    "INSERT INTO document_attribute_definition",
    "UPDATE document_attribute_definition",
    "DELETE FROM document_attribute_definition",
  ];
  let violations: Vec<String> = files
    .into_iter()
    .filter_map(|path| {
      let source = fs::read_to_string(&path).expect("read rust source");
      forbidden
        .iter()
        .any(|needle| source.contains(needle))
        .then(|| path.strip_prefix(&crates_dir).unwrap_or(&path).display().to_string())
    })
    .collect();

  assert_eq!(
    violations,
    Vec::<String>::new(),
    "productive code must not read or write legacy document metadata storage after canonical cut-over"
  );
}

#[tokio::test]
async fn inv_docmeta_schema04_new_workspace_docs_materialize_defaults_on_insert() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let foreign_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) \
     VALUES ($1, 'Foreign Metadata Defaults', $1, '{}'::jsonb) \
     RETURNING id",
  )
  .bind(format!("foreign-docmeta-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert foreign organization");
  sqlx::query(
    "INSERT INTO organization_document_settings \
       (organization_id, status_schema_id, default_language_id, updated_at) \
     VALUES ( \
       $1, \
       (SELECT id FROM document_status_schema WHERE key = 'simple' LIMIT 1), \
       (SELECT id FROM language_definition WHERE key = 'en' LIMIT 1), \
       now() + interval '1 hour' \
     ) \
     ON CONFLICT (organization_id) DO UPDATE SET \
       status_schema_id = EXCLUDED.status_schema_id, \
       default_language_id = EXCLUDED.default_language_id, \
       updated_at = EXCLUDED.updated_at",
  )
  .bind(foreign_org_id)
  .execute(&pool)
  .await
  .expect("insert foreign organization settings");
  sqlx::query(
    "INSERT INTO organization_document_audience_default (organization_id, audience_id, sort_order) \
     SELECT $1, id, 0 FROM document_audience_definition WHERE key = 'public'",
  )
  .bind(foreign_org_id)
  .execute(&pool)
  .await
  .expect("insert foreign audience default");

  sqlx::query(
    "UPDATE organization_document_settings \
     SET default_language_id = (SELECT id FROM language_definition WHERE key = 'de' LIMIT 1) \
     WHERE organization_id = (SELECT id FROM organization WHERE key = 'myoxus' LIMIT 1)",
  )
  .execute(&pool)
  .await
  .expect("reset shared default organization language for deterministic insert materialization");

  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    type MaterializedMetadataRow = (
      Option<Uuid>,
      String,
      Option<String>,
      String,
      Option<String>,
      String,
      Option<String>,
      String,
      Option<String>,
      String,
      Option<Uuid>,
      String,
      Option<chrono::DateTime<chrono::Utc>>,
      Option<chrono::DateTime<chrono::Utc>>,
      Option<Uuid>,
    );
    let row: MaterializedMetadataRow = sqlx::query_as(
      "SELECT d.status_id, d.status_source, typ.key, d.document_type_source, \
              cls.key, d.classification_source, ret.key, d.retention_policy_source, \
              lang.key, d.language_source, d.responsible_user_id, d.responsible_source, \
              d.metadata_materialized_at, d.metadata_updated_at, d.metadata_updated_by \
       FROM docs d \
       LEFT JOIN document_type_definition typ ON typ.id = d.document_type_id \
       LEFT JOIN document_classification_definition cls ON cls.id = d.classification_id \
       LEFT JOIN document_retention_policy_definition ret ON ret.id = d.retention_policy_id \
       LEFT JOIN language_definition lang ON lang.id = d.language_id \
       WHERE d.id = $1",
    )
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("load materialized doc defaults");

    assert!(row.0.is_some(), "new workspace docs must get an effective status");
    assert_eq!(row.1, "organization", "status comes from seeded organization default");
    assert_eq!(
      row.2.as_deref(),
      Some("documentation"),
      "new docs must get a deterministic default document type"
    );
    assert_eq!(
      row.3, "organization",
      "document type comes from seeded organization default"
    );
    assert_eq!(
      row.4.as_deref(),
      Some("public"),
      "new docs must get a deterministic default classification"
    );
    assert_eq!(
      row.5, "organization",
      "classification comes from seeded organization default"
    );
    assert_eq!(
      row.6.as_deref(),
      Some("standard"),
      "new docs must get a deterministic default retention policy"
    );
    assert_eq!(
      row.7, "organization",
      "retention policy comes from seeded organization default"
    );
    assert_eq!(
      row.8.as_deref(),
      Some("de"),
      "new docs must get deterministic default language"
    );
    assert_eq!(row.9, "organization", "language comes from seeded organization default");
    assert_eq!(
      row.10,
      Some(owner_id),
      "without an explicit manager/default, responsible must fall back to workspace owner"
    );
    assert_eq!(row.11, "fallback", "owner-derived responsible is a fallback source");
    assert!(row.12.is_some(), "metadata_materialized_at must be set on insert");
    assert!(row.13.is_some(), "metadata_updated_at must be set on insert");
    assert_eq!(
      row.14,
      Some(owner_id),
      "metadata_updated_by must use the insert actor when available"
    );

    let audience_keys: Vec<String> = sqlx::query_scalar(
      "SELECT d.key \
       FROM doc_audience_assignment a \
       JOIN document_audience_definition d ON d.id = a.audience_id \
       WHERE a.doc_id = $1 \
       ORDER BY d.key",
    )
    .bind(doc_id)
    .fetch_all(&pool)
    .await
    .expect("load default audience");
    assert_eq!(
      audience_keys,
      vec!["internal".to_string()],
      "new docs must materialize the owning/default organization audience, not an unrelated newer organization"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
  sqlx::query("DELETE FROM organization WHERE id = $1")
    .bind(foreign_org_id)
    .execute(&pool)
    .await
    .expect("cleanup foreign organization");
}

#[tokio::test]
async fn inv_docmeta_schema04b_responsible_fallback_uses_manager_then_owner_then_explicit_default() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let owner_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Owner') RETURNING id")
      .bind(format!("docmeta-resp-owner-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert owner");
  let manager_one_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Manager One') RETURNING id")
      .bind(format!("docmeta-resp-manager1-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert manager one");
  let manager_two_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Manager Two') RETURNING id")
      .bind(format!("docmeta-resp-manager2-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert manager two");
  let workspace_id: Uuid =
    sqlx::query_scalar("INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Responsible Defaults') RETURNING id")
      .bind(owner_id)
      .fetch_one(&pool)
      .await
      .expect("insert workspace");

  let result = async {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Manager', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(manager_one_id)
    .execute(&pool)
    .await
    .expect("insert single manager");

    let single_manager_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Single manager responsible', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert single-manager doc");
    let single_manager_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(single_manager_doc_id)
        .fetch_one(&pool)
        .await
        .expect("single manager responsible");
    assert_eq!(
      single_manager_responsible,
      (Some(manager_one_id), "fallback".to_string()),
      "exactly one accepted Manager must become responsible fallback"
    );

    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Manager', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(manager_two_id)
    .execute(&pool)
    .await
    .expect("insert second manager");

    let multiple_manager_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Multiple manager responsible', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert multiple-manager doc");
    let multiple_manager_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(multiple_manager_doc_id)
        .fetch_one(&pool)
        .await
        .expect("multiple manager responsible");
    assert_eq!(
      multiple_manager_responsible,
      (Some(owner_id), "fallback".to_string()),
      "multiple accepted Managers are ambiguous; responsible must fall back to workspace owner"
    );

    sqlx::query(
      "INSERT INTO document_workspace_settings (workspace_id, default_responsible_user_id) \
       VALUES ($1, $2) \
       ON CONFLICT (workspace_id) DO UPDATE SET default_responsible_user_id = EXCLUDED.default_responsible_user_id",
    )
    .bind(workspace_id)
    .bind(manager_two_id)
    .execute(&pool)
    .await
    .expect("set explicit workspace responsible default");

    let explicit_default_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Explicit responsible default', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert explicit-default doc");
    let explicit_default_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(explicit_default_doc_id)
        .fetch_one(&pool)
        .await
        .expect("explicit default responsible");
    assert_eq!(
      explicit_default_responsible,
      (Some(manager_two_id), "workspace".to_string()),
      "explicit workspace responsible default must override manager/owner fallback"
    );
  };

  result.await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![owner_id, manager_one_id, manager_two_id])
    .execute(&pool)
    .await
    .expect("cleanup users");
}

#[tokio::test]
async fn inv_docmeta_schema04c_responsible_ignores_invalid_defaults_and_uses_created_by_without_owner() {
  let pool = setup_pool().await;
  migrate(&pool).await;

  let owner_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Validity Owner') RETURNING id")
      .bind(format!("docmeta-resp-valid-owner-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert owner");
  let invalid_default_id: Uuid = sqlx::query_scalar(
    "INSERT INTO users (email, name, status) VALUES ($1, 'Responsible Invalid Default', 'disabled') RETURNING id",
  )
  .bind(format!("docmeta-resp-invalid-{}@test.invalid", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert invalid default user");
  let deleted_default_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Deleted Default') RETURNING id")
      .bind(format!("docmeta-resp-deleted-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert deleted default user");
  let creator_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'Responsible Creator Fallback') RETURNING id")
      .bind(format!("docmeta-resp-creator-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert creator");

  let workspace_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Responsible Invalid Defaults') RETURNING id",
  )
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .expect("insert workspace");
  let ownerless_workspace_id: Uuid = sqlx::query_scalar(
    "INSERT INTO workspaces (owner_user_id, name, created_by_user_id) \
     VALUES (NULL, 'Responsible Ownerless', $1) RETURNING id",
  )
  .bind(creator_id)
  .fetch_one(&pool)
  .await
  .expect("insert ownerless workspace");

  let result = async {
    let invalid_user_is_eligible: bool =
      sqlx::query_scalar("SELECT document_metadata_is_valid_responsible_user($1, $2)")
        .bind(workspace_id)
        .bind(invalid_default_id)
        .fetch_one(&pool)
        .await
        .expect("validate invalid default");
    assert!(
      !invalid_user_is_eligible,
      "disabled or workspace-unrelated users must not be eligible responsible defaults"
    );

    sqlx::query(
      "INSERT INTO document_workspace_settings (workspace_id, default_responsible_user_id) \
       VALUES ($1, $2) \
       ON CONFLICT (workspace_id) DO UPDATE SET default_responsible_user_id = EXCLUDED.default_responsible_user_id",
    )
    .bind(workspace_id)
    .bind(invalid_default_id)
    .execute(&pool)
    .await
    .expect("set invalid workspace responsible default");

    let invalid_default_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Invalid responsible default', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert invalid-default doc");
    let invalid_default_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(invalid_default_doc_id)
        .fetch_one(&pool)
        .await
        .expect("invalid-default responsible");
    assert_eq!(
      invalid_default_responsible,
      (Some(owner_id), "fallback".to_string()),
      "invalid explicit responsible defaults must not override owner fallback"
    );

    let invalid_explicit_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by, responsible_user_id) \
       VALUES ($1, 'Invalid explicit responsible', $2, $2, $3) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .bind(invalid_default_id)
    .fetch_one(&pool)
    .await
    .expect("insert invalid-explicit doc");
    let invalid_explicit_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(invalid_explicit_doc_id)
        .fetch_one(&pool)
        .await
        .expect("invalid-explicit responsible");
    assert_eq!(
      invalid_explicit_responsible,
      (Some(owner_id), "fallback".to_string()),
      "direct inserts must not persist an invalid explicit responsible user as document metadata"
    );

    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(deleted_default_id)
    .execute(&pool)
    .await
    .expect("insert deleted default membership");
    sqlx::query("UPDATE document_workspace_settings SET default_responsible_user_id = $2 WHERE workspace_id = $1")
      .bind(workspace_id)
      .bind(deleted_default_id)
      .execute(&pool)
      .await
      .expect("set deleted workspace responsible default");
    sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(deleted_default_id)
      .execute(&pool)
      .await
      .expect("delete responsible default user");

    let deleted_default_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Deleted responsible default', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert deleted-default doc");
    let deleted_default_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(deleted_default_doc_id)
        .fetch_one(&pool)
        .await
        .expect("deleted-default responsible");
    assert_eq!(
      deleted_default_responsible,
      (Some(owner_id), "fallback".to_string()),
      "deleted responsible defaults must be nulled by FK and fall back server-side"
    );

    let ownerless_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) \
       VALUES ($1, 'Ownerless responsible fallback', $2, $2) RETURNING id",
    )
    .bind(ownerless_workspace_id)
    .bind(creator_id)
    .fetch_one(&pool)
    .await
    .expect("insert ownerless workspace doc");
    let ownerless_responsible: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(ownerless_doc_id)
        .fetch_one(&pool)
        .await
        .expect("ownerless responsible");
    assert_eq!(
      ownerless_responsible,
      (Some(creator_id), "fallback".to_string()),
      "ownerless workspaces without a single manager must fall back to docs.created_by"
    );
  };

  result.await;
  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(vec![workspace_id, ownerless_workspace_id])
    .execute(&pool)
    .await
    .expect("cleanup workspaces");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![owner_id, invalid_default_id, creator_id])
    .execute(&pool)
    .await
    .expect("cleanup users");
}

#[tokio::test]
async fn inv_docmeta_schema05_workspace_rematerializer_updates_inherited_defaults_only() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let repository = PgDocumentMetadataRepository::new(pool.clone());
  let (owner_id, member_id, workspace_id, inherited_doc_id) = seed_workspace(&pool).await;
  let admin_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name, is_admin) VALUES ($1, 'DocMetaRematAdmin', true) RETURNING id")
      .bind(format!("docmeta-remat-admin-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert rematerializer admin");

  let result = async {
    let org_key = format!("docmeta-remat-{}", Uuid::new_v4());
    let dedicated_org_id: Uuid = sqlx::query_scalar(
      "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'DocMeta Rematerializer', $1, '{}'::jsonb) RETURNING id",
    )
    .bind(&org_key)
    .fetch_one(&pool)
    .await
    .expect("insert dedicated organization");
    let unit_type_id: Uuid = sqlx::query_scalar(
      "INSERT INTO organization_unit_type \
         (organization_id, key, label, is_structural, can_have_children, can_be_root_level, \
          can_be_manager_created, can_have_cross_unit_members, can_own_workspaces, can_manage_workspaces) \
       VALUES ($1, 'remat-root', 'Rematerializer Root', true, true, true, false, false, true, true) \
       RETURNING id",
    )
    .bind(dedicated_org_id)
    .fetch_one(&pool)
    .await
    .expect("insert dedicated organization unit type");
    let unit_id: Uuid = sqlx::query_scalar(
      "INSERT INTO organization_unit (organization_id, unit_type_id, name, slug, created_by) \
       VALUES ($1, $2, 'Rematerializer Unit', 'remat-unit', $3) RETURNING id",
    )
    .bind(dedicated_org_id)
    .bind(unit_type_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert dedicated organization unit");
    sqlx::query(
      "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $2, 'owner')",
    )
    .bind(unit_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("link workspace to dedicated organization");

    let effective_org_id: Uuid = sqlx::query_scalar("SELECT document_metadata_effective_organization_id($1)")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("effective organization");
    assert_eq!(
      effective_org_id, dedicated_org_id,
      "rematerializer test must not mutate the shared default organization"
    );
    let de_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'de'")
      .fetch_one(&pool)
      .await
      .expect("de language id");
    let en_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'en'")
      .fetch_one(&pool)
      .await
      .expect("en language id");
    let fr_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'fr'")
      .fetch_one(&pool)
      .await
      .expect("fr language id");

    let before: (Uuid, i64, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT language_id, metadata_revision, updated_at FROM docs WHERE id = $1")
        .bind(inherited_doc_id)
        .fetch_one(&pool)
        .await
        .expect("metadata state before rematerialization");
    let org_target_language_id = if before.0 == en_language_id {
      de_language_id
    } else {
      en_language_id
    };

    sqlx::query(
      "INSERT INTO organization_document_settings (organization_id, default_language_id, updated_by) \
       VALUES ($1, $2, $3) \
       ON CONFLICT (organization_id) DO UPDATE SET default_language_id = EXCLUDED.default_language_id, updated_by = EXCLUDED.updated_by",
    )
    .bind(effective_org_id)
    .bind(org_target_language_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("change organization language default");

    let after_org: (Uuid, String, i64, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT language_id, language_source, metadata_revision, updated_at FROM docs WHERE id = $1")
        .bind(inherited_doc_id)
        .fetch_one(&pool)
        .await
        .expect("metadata state after org rematerialization");
    assert_eq!(after_org.0, org_target_language_id);
    assert_eq!(after_org.1, "organization");
    assert!(
      after_org.2 > before.1,
      "visible default changes must bump metadata_revision"
    );
    assert_eq!(
      after_org.3, before.2,
      "default rematerialization must not touch docs.updated_at"
    );
    let summary = repository
      .rematerialize_workspace_defaults(workspace_id, Some(owner_id))
      .await
      .expect("rematerialize organization default");
    assert_eq!(summary.scanned_count, 1);
    assert_eq!(
      summary.changed_count, 0,
      "organization default trigger must make the explicit rematerializer call idempotent"
    );

    let no_op_revision = after_org.2;
    let no_op = repository
      .rematerialize_workspace_defaults(workspace_id, Some(owner_id))
      .await
      .expect("rematerialize without value change");
    assert_eq!(no_op.changed_count, 0, "idempotent rerun must not bump revision");
    let revision_after_no_op: i64 = sqlx::query_scalar("SELECT metadata_revision FROM docs WHERE id = $1")
      .bind(inherited_doc_id)
      .fetch_one(&pool)
      .await
      .expect("revision after no-op");
    assert_eq!(revision_after_no_op, no_op_revision);

    sqlx::query(
      "INSERT INTO document_workspace_settings (workspace_id, default_language_id, updated_by) \
       VALUES ($1, $2, $3) \
       ON CONFLICT (workspace_id) DO UPDATE SET default_language_id = EXCLUDED.default_language_id, updated_by = EXCLUDED.updated_by",
    )
    .bind(workspace_id)
    .bind(fr_language_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("set workspace language override");
    let after_workspace_trigger: (Uuid, String) =
      sqlx::query_as("SELECT language_id, language_source FROM docs WHERE id = $1")
        .bind(inherited_doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after workspace override trigger");
    assert_eq!(
      after_workspace_trigger,
      (fr_language_id, "workspace".to_string()),
      "workspace override trigger must rematerialize inherited docs immediately"
    );
    let workspace_override = repository
      .rematerialize_workspace_defaults(workspace_id, Some(owner_id))
      .await
      .expect("rematerialize workspace override");
    assert_eq!(
      workspace_override.changed_count, 0,
      "workspace override trigger must make the explicit rematerializer call idempotent"
    );

    let override_doc_id: Uuid = sqlx::query_scalar(
      "INSERT INTO docs (workspace_id, title, created_by, updated_by) VALUES ($1, 'Inherited Override Doc', $2, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .expect("insert workspace override doc");

    sqlx::query(
      "UPDATE docs SET language_id = $2, language_source = 'document', metadata_updated_by = $3 WHERE id = $1",
    )
    .bind(inherited_doc_id)
    .bind(de_language_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("make first doc explicit");

    sqlx::query(
      "UPDATE document_workspace_settings SET default_language_id = NULL, updated_by = $2 WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("remove workspace override");
    let remove_override = repository
      .rematerialize_workspace_defaults(workspace_id, Some(owner_id))
      .await
      .expect("rematerialize after removing workspace override");
    assert_eq!(
      remove_override.changed_count, 0,
      "override-removal trigger must rematerialize inherited docs before an explicit no-op rerun"
    );

    let explicit_doc: (Uuid, String) = sqlx::query_as("SELECT language_id, language_source FROM docs WHERE id = $1")
      .bind(inherited_doc_id)
      .fetch_one(&pool)
      .await
      .expect("explicit doc after override removal");
    assert_eq!(explicit_doc, (de_language_id, "document".to_string()));

    let inherited_doc: (Uuid, String) = sqlx::query_as("SELECT language_id, language_source FROM docs WHERE id = $1")
      .bind(override_doc_id)
      .fetch_one(&pool)
      .await
      .expect("inherited doc after override removal");
    assert_eq!(inherited_doc, (org_target_language_id, "organization".to_string()));

    dedicated_org_id
  };

  let dedicated_org_id = result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("cleanup rematerializer admin");
  sqlx::query("DELETE FROM organization_unit WHERE organization_id = $1")
    .bind(dedicated_org_id)
    .execute(&pool)
    .await
    .expect("cleanup dedicated organization units");
  sqlx::query("DELETE FROM organization WHERE id = $1")
    .bind(dedicated_org_id)
    .execute(&pool)
    .await
    .expect("cleanup dedicated organization");
}

#[tokio::test]
async fn inv_docmeta_schema05b_default_and_responsible_changes_rematerialize_automatically() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;
  let admin_id: Uuid = sqlx::query_scalar(
    "INSERT INTO users (email, name, is_admin) VALUES ($1, 'DocMetaAutoRematAdmin', true) RETURNING id",
  )
  .bind(format!("docmeta-auto-remat-admin-{}@test.invalid", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert auto-rematerializer admin");
  let org_key = format!("docmeta-auto-remat-{}", Uuid::new_v4());
  let dedicated_org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) VALUES ($1, 'DocMeta Auto Rematerializer', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(&org_key)
  .fetch_one(&pool)
  .await
  .expect("insert dedicated auto-rematerializer organization");
  let unit_type_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization_unit_type \
       (organization_id, key, label, is_structural, can_have_children, can_be_root_level, \
        can_be_manager_created, can_have_cross_unit_members, can_own_workspaces, can_manage_workspaces) \
     VALUES ($1, 'auto-remat-root', 'Auto Rematerializer Root', true, true, true, false, false, true, true) \
     RETURNING id",
  )
  .bind(dedicated_org_id)
  .fetch_one(&pool)
  .await
  .expect("insert dedicated auto-rematerializer organization unit type");
  let unit_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization_unit (organization_id, unit_type_id, name, slug, created_by) \
     VALUES ($1, $2, 'Auto Rematerializer Unit', 'auto-remat-unit', $3) RETURNING id",
  )
  .bind(dedicated_org_id)
  .bind(unit_type_id)
  .bind(owner_id)
  .fetch_one(&pool)
  .await
  .expect("insert dedicated auto-rematerializer organization unit");
  sqlx::query("INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $2, 'owner')")
    .bind(unit_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("link workspace to dedicated auto-rematerializer organization");

  let result = async {
    let org_id: Uuid = sqlx::query_scalar("SELECT document_metadata_effective_organization_id($1)")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("effective organization");
    assert_eq!(
      org_id, dedicated_org_id,
      "automatic rematerialization test must not mutate the shared default organization"
    );
    let current_org_language_id: Option<Uuid> =
      sqlx::query_scalar("SELECT default_language_id FROM organization_document_settings WHERE organization_id = $1")
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .expect("current organization language default");
    let current_doc_language_id: Option<Uuid> = sqlx::query_scalar("SELECT language_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("current document language before org-default update");
    let org_language_id: Uuid = sqlx::query_scalar(
      "SELECT id FROM language_definition \
       WHERE key IN ('de', 'en', 'fr') \
         AND id IS DISTINCT FROM $1 \
         AND id IS DISTINCT FROM $2 \
       ORDER BY key LIMIT 1",
    )
    .bind(current_org_language_id)
    .bind(current_doc_language_id)
    .fetch_one(&pool)
    .await
    .expect("alternate organization language");
    let fr_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'fr'")
      .fetch_one(&pool)
      .await
      .expect("fr language");
    let before_updated_at: chrono::DateTime<chrono::Utc> =
      sqlx::query_scalar("SELECT updated_at FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("content updated_at before defaults");

    sqlx::query(
      "UPDATE organization_document_settings SET default_language_id = $2, updated_by = $3 WHERE organization_id = $1",
    )
    .bind(org_id)
    .bind(org_language_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("update organization language default");
    let after_org: (Uuid, String, Option<Uuid>, chrono::DateTime<chrono::Utc>) =
      sqlx::query_as("SELECT language_id, language_source, metadata_updated_by, updated_at FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after organization default trigger");
    assert_eq!(
      after_org,
      (
        org_language_id,
        "organization".to_string(),
        Some(admin_id),
        before_updated_at
      ),
      "organization default writes must synchronously rematerialize inherited docs without touching content updated_at"
    );

    sqlx::query(
      "INSERT INTO document_workspace_settings (workspace_id, default_language_id, updated_by) \
       VALUES ($1, $2, $3) \
       ON CONFLICT (workspace_id) DO UPDATE SET default_language_id = EXCLUDED.default_language_id, updated_by = EXCLUDED.updated_by",
    )
    .bind(workspace_id)
    .bind(fr_language_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("set workspace language override");
    let after_workspace: (Uuid, String, Option<Uuid>) =
      sqlx::query_as("SELECT language_id, language_source, metadata_updated_by FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after workspace default trigger");
    assert_eq!(
      after_workspace,
      (fr_language_id, "workspace".to_string(), Some(owner_id)),
      "workspace override writes must synchronously rematerialize inherited docs"
    );

    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Manager', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&pool)
    .await
    .expect("insert manager membership");
    let after_manager: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after manager trigger");
    assert_eq!(
      after_manager,
      (Some(member_id), "fallback".to_string()),
      "single accepted Manager changes the responsible fallback and must rematerialize existing docs"
    );

    sqlx::query("UPDATE workspace_memberships SET status = 'Pending' WHERE workspace_id = $1 AND user_id = $2")
      .bind(workspace_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("make manager inactive");
    let after_manager_removed: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after manager removal trigger");
    assert_eq!(
      after_manager_removed,
      (Some(owner_id), "fallback".to_string()),
      "manager status changes must rematerialize responsible fallback"
    );

    sqlx::query("UPDATE workspaces SET owner_user_id = $2 WHERE id = $1")
      .bind(workspace_id)
      .bind(member_id)
      .execute(&pool)
      .await
      .expect("change workspace owner");
    let after_owner: (Option<Uuid>, String) =
      sqlx::query_as("SELECT responsible_user_id, responsible_source FROM docs WHERE id = $1")
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("doc after owner trigger");
    assert_eq!(
      after_owner,
      (Some(member_id), "fallback".to_string()),
      "workspace owner changes must rematerialize responsible fallback"
    );
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("cleanup auto-rematerializer admin");
  sqlx::query("DELETE FROM organization_unit WHERE organization_id = $1")
    .bind(dedicated_org_id)
    .execute(&pool)
    .await
    .expect("cleanup dedicated auto-rematerializer organization units");
  sqlx::query("DELETE FROM organization WHERE id = $1")
    .bind(dedicated_org_id)
    .execute(&pool)
    .await
    .expect("cleanup dedicated auto-rematerializer organization");
}

#[tokio::test]
async fn inv_docmeta_schema06_document_policy_is_actor_and_org_policy_enforced() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataRepository::new(pool.clone());
    let classification_id: Uuid =
      sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = 'internal'")
        .fetch_one(&pool)
        .await
        .expect("select classification");
    let language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'fr'")
      .fetch_one(&pool)
      .await
      .expect("select language");

    repository
      .apply_patch(
        doc_id,
        owner_id,
        &DocumentMetadataPatch {
          classification_id: Some(Some(classification_id)),
          ..DocumentMetadataPatch::default()
        },
      )
      .await
      .expect("workspace owner may edit document-level metadata");

    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Commenter', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&pool)
    .await
    .expect("insert commenter membership");
    let denied = repository
      .apply_patch(
        doc_id,
        member_id,
        &DocumentMetadataPatch {
          classification_id: Some(None),
          ..DocumentMetadataPatch::default()
        },
      )
      .await;
    assert!(
      matches!(denied, Err(RepositoryError::Validation(ref message)) if message.contains("locked for actor")),
      "commenters must not bypass document_edit_role via direct repository writes: {denied:?}"
    );

    let org_id: Uuid = sqlx::query_scalar("SELECT document_metadata_effective_organization_id($1)")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("effective organization");
    sqlx::query(
      "UPDATE organization_document_metadata_policy \
       SET enabled = false, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1 AND field_key = $2",
    )
    .bind(org_id)
    .bind("language")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("disable language in org policy");

    let projection = repository
      .get_projection(doc_id, workspace_id)
      .await
      .expect("projection after disabled policy")
      .expect("metadata projection");
    let language_lock = projection
      .policy
      .locks
      .iter()
      .find(|lock| lock.key == "language")
      .expect("language lock must be projected");
    assert!(
      !language_lock.editable
        && language_lock
          .reason
          .as_deref()
          .is_some_and(|reason| reason.contains("disabled by organization policy")),
      "native projection must expose org-policy disabled state as a server-derived lock"
    );

    let disabled = repository
      .apply_patch(
        doc_id,
        owner_id,
        &DocumentMetadataPatch {
          language_id: Some(Some(language_id)),
          ..DocumentMetadataPatch::default()
        },
      )
      .await;
    assert!(
      matches!(disabled, Err(RepositoryError::Validation(ref message)) if message.contains("disabled by organization policy")),
      "org policy must reject disabled fields even for an otherwise allowed actor: {disabled:?}"
    );

    sqlx::query(
      "UPDATE organization_document_metadata_policy \
       SET enabled = true, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1 AND field_key = $2",
    )
    .bind(org_id)
    .bind("language")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("restore shared org policy");

    let projection = repository
      .get_projection(doc_id, workspace_id)
      .await
      .expect("projection before subsystem policy disable")
      .expect("metadata projection");
    let primary_mode_lock = projection
      .policy
      .locks
      .iter()
      .find(|lock| lock.key == "primaryMode")
      .expect("primaryMode lock must be projected");
    assert!(
      primary_mode_lock.editable,
      "supported subsystem routes must be editable through setDocumentMetadata when actor policy allows them"
    );

    sqlx::query(
      "UPDATE organization_document_metadata_policy \
       SET enabled = false, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1 AND field_key = $2",
    )
    .bind(org_id)
    .bind("primaryMode")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("disable primaryMode in org policy");
    let disabled_subsystem = repository
      .apply_patch(
        doc_id,
        owner_id,
        &DocumentMetadataPatch {
          primary_mode: Some(Some("edgeless".to_string())),
          ..DocumentMetadataPatch::default()
        },
      )
      .await;
    assert!(
      matches!(disabled_subsystem, Err(RepositoryError::Validation(ref message)) if message.contains("disabled by organization policy")),
      "org policy must reject disabled subsystem fields instead of bypassing patch_field_keys: {disabled_subsystem:?}"
    );

    sqlx::query(
      "UPDATE organization_document_metadata_policy \
       SET enabled = true, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1 AND field_key = $2",
    )
    .bind(org_id)
    .bind("primaryMode")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("restore primaryMode org policy");
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema06b_workspace_default_policy_requires_workspace_admin_role() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let (owner_id, member_id, workspace_id, _doc_id) = seed_workspace(&pool).await;

  let result = async {
    let repository = PgDocumentMetadataPolicyRepository::new(pool.clone());
    let classification_id: Uuid =
      sqlx::query_scalar("SELECT id FROM document_classification_definition WHERE key = 'internal'")
        .fetch_one(&pool)
        .await
        .expect("select classification");

    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) \
       VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&pool)
    .await
    .expect("insert collaborator membership");
    let denied = repository
      .upsert_workspace_settings(&DocumentWorkspaceSettings {
        workspace_id,
        status_schema_id: None,
        default_status_id: None,
        version_policy_id: None,
        default_document_type_id: None,
        default_classification_id: Some(classification_id),
        default_retention_policy_id: None,
        updated_by: Some(member_id),
        updated_at: chrono::Utc::now(),
      })
      .await;
    assert!(
      matches!(denied, Err(RepositoryError::Validation(ref message)) if message.contains("locked for actor")),
      "workspace default writes must be gated by workspace_edit_role, not by UI visibility: {denied:?}"
    );

    repository
      .upsert_workspace_settings(&DocumentWorkspaceSettings {
        workspace_id,
        status_schema_id: None,
        default_status_id: None,
        version_policy_id: None,
        default_document_type_id: None,
        default_classification_id: Some(classification_id),
        default_retention_policy_id: None,
        updated_by: Some(owner_id),
        updated_at: chrono::Utc::now(),
      })
      .await
      .expect("workspace owner may update inherited workspace defaults");
  };

  result.await;
  cleanup_workspace(&pool, owner_id, member_id, workspace_id).await;
}

#[tokio::test]
async fn inv_docmeta_schema06c_organization_defaults_require_global_admin_actor() {
  let pool = setup_pool().await;
  migrate(&pool).await;
  let admin_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name, is_admin) VALUES ($1, 'DocMetaOrgAdmin', true) RETURNING id")
      .bind(format!("docmeta-org-admin-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert global admin");
  let member_id: Uuid =
    sqlx::query_scalar("INSERT INTO users (email, name) VALUES ($1, 'DocMetaOrgMember') RETURNING id")
      .bind(format!("docmeta-org-member-{}@test.invalid", Uuid::new_v4()))
      .fetch_one(&pool)
      .await
      .expect("insert regular member");
  let org_id: Uuid = sqlx::query_scalar(
    "INSERT INTO organization (key, name, slug, metadata) \
     VALUES ($1, 'DocMeta Org Policy', $1, '{}'::jsonb) RETURNING id",
  )
  .bind(format!("docmeta-org-policy-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert organization");

  let result = async {
    let de_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'de'")
      .fetch_one(&pool)
      .await
      .expect("select German language");
    let fr_language_id: Uuid = sqlx::query_scalar("SELECT id FROM language_definition WHERE key = 'fr'")
      .fetch_one(&pool)
      .await
      .expect("select French language");

    let denied = sqlx::query(
      "UPDATE organization_document_settings \
       SET default_language_id = $2, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1",
    )
    .bind(org_id)
    .bind(fr_language_id)
    .bind(member_id)
    .execute(&pool)
    .await;
    assert!(
      denied.is_err(),
      "regular users must not update organization document defaults directly"
    );

    sqlx::query(
      "UPDATE organization_document_settings \
       SET default_language_id = $2, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1",
    )
    .bind(org_id)
    .bind(de_language_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("global admin may update organization document defaults");

    sqlx::query(
      "UPDATE organization_document_metadata_policy \
       SET enabled = false, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1 AND field_key = $2",
    )
    .bind(org_id)
    .bind("language")
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("disable language org policy");

    let disabled = sqlx::query(
      "UPDATE organization_document_settings \
       SET default_language_id = $2, updated_by = $3, updated_at = now() \
       WHERE organization_id = $1",
    )
    .bind(org_id)
    .bind(fr_language_id)
    .bind(admin_id)
    .execute(&pool)
    .await;
    assert!(
      disabled.is_err(),
      "disabled organization metadata policy must block org defaults even for global admins"
    );
  };

  result.await;
  sqlx::query("DELETE FROM organization WHERE id = $1")
    .bind(org_id)
    .execute(&pool)
    .await
    .expect("cleanup organization");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![admin_id, member_id])
    .execute(&pool)
    .await
    .expect("cleanup users");
}
