// SPDX-License-Identifier: AGPL-3.0-or-later

//! Release-boundary tests for baseline 1000 and its append-only forward chain.
//! Every database created here is isolated and removed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use futures_util::FutureExt;
use sha2::{Digest, Sha384};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const BASELINE: &str = include_str!("../migrations/1000_myoxus_schema_baseline.sql");
const GANTT_VIEW_KIND: &str = include_str!("../migrations/1001_database_gantt_view_kind.sql");
const GIT_TOKEN_ROTATION: &str = include_str!("../migrations/1002_git_token_rotation.sql");
const WORKSPACE_TAG_RETIRED_IDS: &str = include_str!("../migrations/1003_workspace_tag_retired_ids.sql");
const WORKSPACE_TAG_SEARCH_PAYLOAD: &str = include_str!("../migrations/1004_workspace_tag_search_payload.sql");

const MEETING_WORK_AREAS: &str = include_str!("../migrations/1007_meeting_work_areas.sql");
const ONBOARDING_LEARNING_GUIDES: &str = include_str!("../migrations/1008_onboarding_learning_guides.sql");
const THEME_LINK_COLOR: &str = include_str!("../migrations/1010_theme_link_color.sql");
const WORKSPACE_PUBLIC_DESCRIPTION: &str = include_str!("../migrations/1011_workspace_public_description.sql");
const DOCUMENT_METADATA_PROJECTION_FRESHNESS: &str =
  include_str!("../migrations/1012_document_metadata_projection_freshness.sql");
const DOCUMENT_HISTORY_EDIT_CAPTURE_SETTINGS: &str =
  include_str!("../migrations/1013_document_history_edit_capture_settings.sql");
const DOCUMENT_HISTORY_PROVENANCE: &str = include_str!("../migrations/1014_document_history_provenance.sql");
const DOCUMENT_EDIT_CAPTURE_DUE_STATE: &str = include_str!("../migrations/1015_document_edit_capture_due_state.sql");
const DOCUMENT_HISTORY_CAPTURE_REQUESTS: &str =
  include_str!("../migrations/1016_document_history_capture_requests.sql");
const DOCUMENT_METADATA_INDEX_REVISION: &str = include_str!("../migrations/1017_document_metadata_index_revision.sql");
const DATABASE_PAGE_INVENTORY_REVISION: &str = include_str!("../migrations/1018_database_page_inventory_revision.sql");
const GIT_SYNC_HISTORY_CAPTURE: &str = include_str!("../migrations/1019_git_sync_history_capture.sql");
const CALENDAR_DETACHED_DELETE_INTENTS: &str = include_str!("../migrations/1020_calendar_detached_delete_intents.sql");
const WORKSPACE_IMPORT_SELECTED_FORMAT: &str = include_str!("../migrations/1021_workspace_import_selected_format.sql");
const MCP_DOCUMENT_WRITE_RECOVERY: &str = include_str!("../migrations/1022_mcp_document_write_recovery.sql");
const WORKSPACE_TRANSFER_INTEGRITY: &str = include_str!("../migrations/1023_workspace_transfer_integrity.sql");
const TERMINAL_ACCOUNT_IDENTITY: &str = include_str!("../migrations/1024_terminal_account_identity.sql");
const WORKSPACE_CONTENT_ERROR_PHASE: &str = include_str!("../migrations/1025_workspace_content_error_phase.sql");
const WORKSPACE_CONTENT_DIAGNOSTIC_CAUSES: &str =
  include_str!("../migrations/1026_workspace_content_diagnostic_causes.sql");
const WORKSPACE_CONTENT_MERGED_TAG_MAPPINGS: &str =
  include_str!("../migrations/1027_workspace_content_merged_tag_mappings.sql");
const DOCUMENT_CHANGE_BATCHES: &str = include_str!("../migrations/1031_document_change_batches.sql");
const HISTORY_REFERENCE_ORIGIN: &str = include_str!("../migrations/1030_history_reference_origin.sql");
const WORKSPACE_CONTENT_PRECISE_CONDITIONS: &str =
  include_str!("../migrations/1032_workspace_content_precise_conditions.sql");
const CALENDAR_MAIL_INTENT: &str = include_str!("../migrations/1033_calendar_mail_intent.sql");
const CALENDAR_MAIL_SCOPE_INDEX: &str = include_str!("../migrations/1034_calendar_mail_scope_index.sql");
const MCP_DOCUMENT_PAYLOAD_FORMAT: &str = include_str!("../migrations/1038_mcp_document_payload_format.sql");
const DOCUMENT_STATUS_OKF_MAPPING: &str = include_str!("../migrations/1039_document_status_okf_mapping.sql");
const WORKSPACE_CONTENT_WORKSPACE_DELETION: &str =
  include_str!("../migrations/1040_workspace_content_workspace_deletion.sql");
const DATABASE_TASK_NOTIFICATION_INTENT: &str =
  include_str!("../migrations/1042_database_task_notification_intent.sql");
const DATABASE_TASK_CAPTURE: &str = include_str!("../migrations/1041_database_task_capture.sql");
const MANAGED_DATABASE_SCHEMA: &str = include_str!("../migrations/1043_managed_database_schema.sql");
const TASK_MOVE_CONSTRAINTS: &str = include_str!("../migrations/1044_task_move_constraints.sql");
const WORKSPACE_STARTER_APPLICATIONS: &str = include_str!("../migrations/1045_workspace_starter_applications.sql");
const TEMPLATE_DEFAULT_RELEASE_OWNERSHIP: &str =
  include_str!("../migrations/1046_template_default_release_ownership.sql");
const TEMPLATE_REVISION_PUBLICATION_OWNERSHIP: &str =
  include_str!("../migrations/1047_template_revision_publication_ownership.sql");
const DATABASE_ROW_TEMPLATE_REVISIONS: &str = include_str!("../migrations/1048_database_row_template_revisions.sql");
const WORKSPACE_PROJECT_STARTERS: &str = include_str!("../migrations/1049_workspace_project_starters.sql");
const WORKSPACE_PROJECT_COMPONENTS: &str = include_str!("../migrations/1050_workspace_project_components.sql");
const WORKSPACE_PROJECT_PURPOSE: &str = include_str!("../migrations/1051_workspace_project_purpose.sql");
const CONTEXT_DOCUMENT_STARTERS: &str = include_str!("../migrations/1052_context_document_starters.sql");
const WORKSPACE_AUTOMATION_RUNTIME: &str = include_str!("../migrations/1053_workspace_automation_runtime.sql");
const CONTEXT_DOCUMENT_WORKFLOWS: &str = include_str!("../migrations/1054_context_document_workflows.sql");
const DOCUMENT_REVIEW_WORKFLOWS: &str = include_str!("../migrations/1055_document_review_workflows.sql");
const WORKSPACE_AUTOMATION_SIGNAL_OUTBOX: &str =
  include_str!("../migrations/1056_workspace_automation_signal_outbox.sql");
const TASK_HANDOVER_WORKFLOWS: &str = include_str!("../migrations/1057_task_handover_workflows.sql");
const TASK_ASSISTANCE: &str = include_str!("../migrations/1059_task_assistance.sql");
const WORKSPACE_SETUP_WORKFLOWS: &str = include_str!("../migrations/1060_workspace_setup_workflows.sql");
const WORKSPACE_OVERVIEW_SETTINGS: &str = include_str!("../migrations/1061_workspace_overview_settings.sql");
const DOCUMENT_INITIAL_METADATA_PROJECTION: &str =
  include_str!("../migrations/1062_document_initial_metadata_projection.sql");
const COPILOT_RESPONSE_ANCHORS: &str = include_str!("../migrations/1063_copilot_response_anchors.sql");
const COPILOT_CONTEXT_METADATA: &str = include_str!("../migrations/1064_copilot_context_metadata.sql");
const COPILOT_CONTEXT_INGESTION_DUE: &str = include_str!("../migrations/1065_copilot_context_ingestion_due.sql");
const COPILOT_EMBEDDING_DIMENSIONS: &str = include_str!("../migrations/1066_copilot_embedding_dimensions.sql");
const GIT_SYNC_PROFILE_SCOPES: &str = include_str!("../migrations/1067_git_sync_profile_scopes.sql");
const GIT_SYNC_SHARED_CREDENTIAL_LIFETIME: &str =
  include_str!("../migrations/1068_git_sync_shared_credential_lifetime.sql");
const WORKSPACE_CONTENT_EXTRACT_GIT_PLAN: &str =
  include_str!("../migrations/1069_workspace_content_extract_git_plan.sql");
const WORKSPACE_CONTENT_EXTRACT_GIT_PENDING: &str =
  include_str!("../migrations/1070_workspace_content_extract_git_pending.sql");
const WORKSPACE_CONTENT_EXTRACT_GIT_GUARDS: &str =
  include_str!("../migrations/1071_workspace_content_extract_git_guards.sql");
const WORKSPACE_CONTENT_EXTRACT_GIT_COMMIT: &str =
  include_str!("../migrations/1072_workspace_content_extract_git_commit.sql");
const GIT_SYNC_VERIFIED_EXTRACT_CAPTURE: &str =
  include_str!("../migrations/1073_git_sync_verified_extract_capture.sql");
const WORKSPACE_CONTENT_EXTRACT_PROFILE_ADMISSION: &str =
  include_str!("../migrations/1074_workspace_content_extract_profile_admission.sql");
const EXTRACT_DISCONNECT_PROFILE_REPAIR: &str =
  include_str!("../migrations/1075_extract_disconnect_profile_repair.sql");
const WORKSPACE_CONTENT_GIT_UNDO_RECEIPT: &str =
  include_str!("../migrations/1076_workspace_content_git_undo_receipt.sql");
const GIT_SYNC_OPEN_CONFLICT_IDENTITY: &str = include_str!("../migrations/1077_git_sync_open_conflict_identity.sql");
const SCHEDULING_ADMISSION: &str = include_str!("../migrations/1078_scheduling_admission.sql");
const TASK_RECURRENCE_SERIES: &str = include_str!("../migrations/1079_task_recurrence_series.sql");
const TASK_RECURRENCE_COMPLETION: &str = include_str!("../migrations/1080_task_recurrence_completion.sql");
const GUIDE_TEMPLATE_STATE: &str = include_str!("../migrations/1081_guide_template_state.sql");
const TASK_RECURRENCE_LIFECYCLE: &str = include_str!("../migrations/1082_task_recurrence_lifecycle.sql");
const CALENDAR_TIMING_DEFINITIONS: &str = include_str!("../migrations/1083_calendar_timing_definitions.sql");
const CALENDAR_SERIES_BOUNDARIES: &str = include_str!("../migrations/1084_calendar_series_boundaries.sql");
const CALENDAR_PAUSE_INTERVALS: &str = include_str!("../migrations/1085_calendar_pause_intervals.sql");
const CALENDAR_SOURCE_CONTEXT: &str = include_str!("../migrations/1086_calendar_source_context.sql");
const DOCUMENT_REVIEW_PLANNING: &str = include_str!("../migrations/1087_document_review_planning.sql");
const DOCUMENT_REVIEW_CYCLE_ADMISSION: &str = include_str!("../migrations/1088_document_review_cycle_admission.sql");
const DOCUMENT_REVIEW_GENERATION: &str = include_str!("../migrations/1089_document_review_generation.sql");
const CALENDAR_REMINDER_ADMISSION: &str = include_str!("../migrations/1090_calendar_reminder_admission.sql");
const DATABASE_REMINDER_ADMISSION: &str = include_str!("../migrations/1091_database_reminder_admission.sql");
const GIT_CRON_ADMISSION: &str = include_str!("../migrations/1092_git_cron_admission.sql");
const GIT_POLLING_ADMISSION: &str = include_str!("../migrations/1093_git_polling_admission.sql");
const GIT_ROTATION_ADMISSION: &str = include_str!("../migrations/1094_git_rotation_admission.sql");
const REGISTERED_JOB_IMPORT: &str = include_str!("../migrations/1095_registered_job_import.sql");
const REGISTERED_JOB_ADMISSION: &str = include_str!("../migrations/1096_registered_job_admission.sql");
const AUTOMATION_EFFECT_CONSOLIDATION: &str = include_str!("../migrations/1058_automation_effect_consolidation.sql");
const AUTOMATION_JOB_IDENTITY: &str = include_str!("../migrations/1037_workspace_automation_job_identity.sql");
const AUDIO_JOB_ATTEMPTS: &str = include_str!("../migrations/1036_audio_job_attempts.sql");
const AUDIO_JOB_RESULTS: &str = include_str!("../migrations/1035_audio_job_results.sql");
const DATABASE_TEMPLATE_OWNED_CONTENT: &str = include_str!("../migrations/1029_database_template_owned_content.sql");
const DOCUMENT_GRAPH_REFERENCE_SCOPE: &str = include_str!("../migrations/1028_document_graph_reference_scope.sql");
const PAGE_REGISTRATION_EVIDENCE: &str = include_str!("../migrations/1009_page_registration_evidence.sql");

const MEETING_TEMPLATE_PRESENTATION: &str = include_str!("../migrations/1006_meeting_template_presentation.sql");

const MEETING_ONBOARDING_TEMPLATES: &str = include_str!("../migrations/1005_meeting_onboarding_templates.sql");

const SEED_TABLES: &[&str] = &[
  "app_configs",
  "app_server_branding",
  "document_audience_definition",
  "document_classification_definition",
  "document_metadata_field_definition",
  "document_metadata_global_epoch",
  "document_retention_policy_definition",
  "document_status_schema",
  "document_status_transition",
  "document_status_value",
  "document_type_definition",
  "document_version_policy",
  "language_definition",
  "organization",
  "organization_document_audience_default",
  "organization_document_metadata_epoch",
  "organization_document_metadata_policy",
  "organization_document_settings",
  "organization_identity",
  "organization_policy",
  "organization_unit_type",
  "template_catalog_entries",
  "template_default_policies",
];

fn sha384(bytes: &[u8]) -> Vec<u8> {
  Sha384::digest(bytes).to_vec()
}

#[test]
fn source_inventory_allows_only_baseline_and_forward_migrations() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR"));
  let active_directory = root.join("migrations");
  for entry in std::fs::read_dir(&active_directory).expect("read active migration directory") {
    let path = entry.expect("read active migration entry").path();
    assert!(path.is_file(), "active migration inventory must contain files only");
    assert_eq!(
      path.extension().and_then(|extension| extension.to_str()),
      Some("sql"),
      "active migration inventory must contain SQL migrations only: {}",
      path.display()
    );
  }

  let active = sql_files(&active_directory);
  assert!(!active.is_empty());
  assert_eq!(
    active[0].file_name().and_then(|name| name.to_str()),
    Some("1000_myoxus_schema_baseline.sql")
  );
  let mut previous = 999_i64;
  for path in &active {
    let version = migration_version(path);
    assert!(version > previous, "active forward migrations must be monotone");
    previous = version;
  }

  assert!(!BASELINE.contains("COPY "));
  assert!(!BASELINE.contains("CREATE INDEX CONCURRENTLY"));
  let inserted: BTreeSet<&str> = BASELINE
    .lines()
    .filter_map(|line| line.strip_prefix("INSERT INTO public."))
    .filter_map(|line| line.split_whitespace().next())
    .collect();
  assert_eq!(inserted, SEED_TABLES.iter().copied().collect());

  let forbidden_macro = format!("sqlx::{}!", "migrate");
  let forbidden_missing = ["ignore", "missing"].join("_");
  let mut macro_owners = Vec::new();
  for path in rust_files(&root.parent().expect("server crates directory")) {
    let source = std::fs::read_to_string(&path).expect("read Rust source");
    let compact = source.split_whitespace().collect::<String>();
    // Reject SQLx configuration, not an unrelated template parser's local
    // include-ignore binding with the same name.
    assert!(
      !source.contains(&format!("set_{forbidden_missing}"))
        && !compact.contains(&format!(".{forbidden_missing}="))
        && !compact.contains(&format!("{forbidden_missing}:")),
      "{} enables missing migrations",
      path.display()
    );
    if source.contains(&forbidden_macro) {
      macro_owners.push(path);
    }
  }
  assert_eq!(macro_owners, [root.join("src/migrations.rs")]);
}

fn sql_files(directory: &Path) -> Vec<PathBuf> {
  let mut files: Vec<PathBuf> = std::fs::read_dir(directory)
    .expect("read migration directory")
    .map(|entry| entry.expect("read migration entry").path())
    .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
    .collect();
  files.sort();
  files
}

fn rust_files(directory: &Path) -> Vec<PathBuf> {
  let mut result = Vec::new();
  let mut pending = vec![directory.to_path_buf()];
  while let Some(path) = pending.pop() {
    for entry in std::fs::read_dir(path).expect("read source directory") {
      let path = entry.expect("read source entry").path();
      if path.is_dir() {
        pending.push(path);
      } else if path.extension().is_some_and(|extension| extension == "rs") {
        result.push(path);
      }
    }
  }
  result.sort();
  result
}

fn migration_version(path: &Path) -> i64 {
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .expect("migration filename must be UTF-8");
  let (version, _) = name
    .split_once('_')
    .expect("migration filename must contain an underscore");
  version
    .parse()
    .expect("migration filename starts with a numeric version")
}

struct DatabaseHarness {
  admin: PgPool,
  options: PgConnectOptions,
  names: Vec<String>,
}

impl DatabaseHarness {
  async fn new() -> Result<Self, sqlx::Error> {
    let url = std::env::var("TEST_DATABASE_URL")
      .or_else(|_| std::env::var("DATABASE_URL"))
      .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_owned());
    let options = PgConnectOptions::from_str(&url).expect("TEST_DATABASE_URL must be PostgreSQL");
    let admin = PgPoolOptions::new()
      .max_connections(1)
      .connect_with(options.clone())
      .await?;
    Ok(Self {
      admin,
      options,
      names: Vec::new(),
    })
  }

  async fn create(&mut self, role: &str) -> Result<PgPool, sqlx::Error> {
    let name = format!("myoxus_migrations_{role}_{}", Uuid::new_v4().simple());
    sqlx::query(&format!(r#"CREATE DATABASE "{name}""#))
      .execute(&self.admin)
      .await?;
    self.names.push(name.clone());
    PgPoolOptions::new()
      .max_connections(4)
      .connect_with(self.options.clone().database(&name))
      .await
  }

  async fn cleanup(self, pools: Vec<PgPool>) -> Result<(), sqlx::Error> {
    for pool in pools {
      pool.close().await;
    }
    for name in self.names.iter().rev() {
      sqlx::query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1")
        .bind(name)
        .execute(&self.admin)
        .await?;
      sqlx::query(&format!(r#"DROP DATABASE IF EXISTS "{name}""#))
        .execute(&self.admin)
        .await?;
    }
    self.admin.close().await;
    Ok(())
  }
}

async fn create_migrations_table(pool: &PgPool) -> Result<(), sqlx::Error> {
  sqlx::raw_sql(
    "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)",
  )
  .execute(pool)
  .await?;
  Ok(())
}

async fn install_baseline_1000(pool: &PgPool) -> Result<(), sqlx::Error> {
  sqlx::raw_sql(BASELINE).execute(pool).await?;
  create_migrations_table(pool).await?;
  sqlx::query(
    "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (1000, 'myoxus schema baseline', TRUE, $1, 0)",
  )
  .bind(sha384(BASELINE.as_bytes()))
  .execute(pool)
  .await?;
  Ok(())
}

async fn seed_stale_database_tag_search_payload(pool: &PgPool) -> Result<Uuid, sqlx::Error> {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let database_id = Uuid::new_v4();
  let text_field_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Tag search migration')")
    .bind(user_id)
    .bind(format!("tag-search-migration-{user_id}@test.invalid"))
    .execute(pool)
    .await?;
  sqlx::query(
    "INSERT INTO workspaces (id, owner_user_id, name, owner_principal_type, owner_principal_id, created_by_user_id) VALUES ($1, $2, 'Tag search migration', 'user', $2, $2)",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await?;
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'Tag search migration', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await?;
  sqlx::query(
    "INSERT INTO workspace_database_fields (id, database_id, name, field_type, position) VALUES ($1, $2, 'Summary', 'text', 0)",
  )
  .bind(text_field_id)
  .bind(database_id)
  .execute(pool)
  .await?;
  sqlx::query(
    "INSERT INTO workspace_database_rows (id, database_id, title, position, created_by, updated_by) VALUES ($1, $2, 'Visible row', 0, $3, $3)",
  )
  .bind(row_id)
  .bind(database_id)
  .bind(user_id)
  .execute(pool)
  .await?;
  sqlx::query(
    "INSERT INTO workspace_database_cell_values (row_id, field_id, database_id, value_json, updated_by) VALUES ($1, $2, $3, to_jsonb('Visible payload'::text), $4)",
  )
  .bind(row_id)
  .bind(text_field_id)
  .bind(database_id)
  .bind(user_id)
  .execute(pool)
  .await?;
  sqlx::query(
    "INSERT INTO workspace_database_row_search (workspace_id, database_id, row_id, workspace_tags, title, search_text) VALUES ($1, $2, $3, '[]'::jsonb, 'Visible row', 'Visible payload retired-tag-id RetiredTag retired-tag tag.red')",
  )
  .bind(workspace_id)
  .bind(database_id)
  .bind(row_id)
  .execute(pool)
  .await?;
  Ok(row_id)
}

async fn ledger_snapshot(pool: &PgPool) -> Vec<(i64, String, bool, Vec<u8>)> {
  sqlx::query_as("SELECT version,description,success,checksum FROM _sqlx_migrations ORDER BY version")
    .fetch_all(pool)
    .await
    .expect("read migration ledger")
}

async fn relation_snapshot(pool: &PgPool) -> Vec<String> {
  sqlx::query_scalar(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname",
  )
  .fetch_all(pool)
  .await
  .expect("read public relation inventory")
}

fn expected_ledger() -> Vec<(i64, &'static str, Vec<u8>)> {
  vec![
    (1000, "myoxus schema baseline", sha384(BASELINE.as_bytes())),
    (1001, "database gantt view kind", sha384(GANTT_VIEW_KIND.as_bytes())),
    (1002, "git token rotation", sha384(GIT_TOKEN_ROTATION.as_bytes())),
    (
      1003,
      "workspace tag retired ids",
      sha384(WORKSPACE_TAG_RETIRED_IDS.as_bytes()),
    ),
    (
      1004,
      "workspace tag search payload",
      sha384(WORKSPACE_TAG_SEARCH_PAYLOAD.as_bytes()),
    ),
    (
      1005,
      "meeting onboarding templates",
      sha384(MEETING_ONBOARDING_TEMPLATES.as_bytes()),
    ),
    (
      1006,
      "meeting template presentation",
      sha384(MEETING_TEMPLATE_PRESENTATION.as_bytes()),
    ),
    (1007, "meeting work areas", sha384(MEETING_WORK_AREAS.as_bytes())),
    (
      1008,
      "onboarding learning guides",
      sha384(ONBOARDING_LEARNING_GUIDES.as_bytes()),
    ),
    (
      1009,
      "page registration evidence",
      sha384(PAGE_REGISTRATION_EVIDENCE.as_bytes()),
    ),
    (1010, "theme link color", sha384(THEME_LINK_COLOR.as_bytes())),
    (
      1011,
      "workspace public description",
      sha384(WORKSPACE_PUBLIC_DESCRIPTION.as_bytes()),
    ),
    (
      1012,
      "document metadata projection freshness",
      sha384(DOCUMENT_METADATA_PROJECTION_FRESHNESS.as_bytes()),
    ),
    (
      1013,
      "document history edit capture settings",
      sha384(DOCUMENT_HISTORY_EDIT_CAPTURE_SETTINGS.as_bytes()),
    ),
    (
      1014,
      "document history provenance",
      sha384(DOCUMENT_HISTORY_PROVENANCE.as_bytes()),
    ),
    (
      1015,
      "document edit capture due state",
      sha384(DOCUMENT_EDIT_CAPTURE_DUE_STATE.as_bytes()),
    ),
    (
      1016,
      "document history capture requests",
      sha384(DOCUMENT_HISTORY_CAPTURE_REQUESTS.as_bytes()),
    ),
    (
      1017,
      "document metadata index revision",
      sha384(DOCUMENT_METADATA_INDEX_REVISION.as_bytes()),
    ),
    (
      1018,
      "database page inventory revision",
      sha384(DATABASE_PAGE_INVENTORY_REVISION.as_bytes()),
    ),
    (
      1019,
      "git sync history capture",
      sha384(GIT_SYNC_HISTORY_CAPTURE.as_bytes()),
    ),
    (
      1020,
      "calendar detached delete intents",
      sha384(CALENDAR_DETACHED_DELETE_INTENTS.as_bytes()),
    ),
    (
      1021,
      "workspace import selected format",
      sha384(WORKSPACE_IMPORT_SELECTED_FORMAT.as_bytes()),
    ),
    (
      1022,
      "mcp document write recovery",
      sha384(MCP_DOCUMENT_WRITE_RECOVERY.as_bytes()),
    ),
    (
      1023,
      "workspace transfer integrity",
      sha384(WORKSPACE_TRANSFER_INTEGRITY.as_bytes()),
    ),
    (
      1024,
      "terminal account identity",
      sha384(TERMINAL_ACCOUNT_IDENTITY.as_bytes()),
    ),
    (
      1025,
      "workspace content error phase",
      sha384(WORKSPACE_CONTENT_ERROR_PHASE.as_bytes()),
    ),
    (
      1026,
      "workspace content diagnostic causes",
      sha384(WORKSPACE_CONTENT_DIAGNOSTIC_CAUSES.as_bytes()),
    ),
    (
      1027,
      "workspace content merged tag mappings",
      sha384(WORKSPACE_CONTENT_MERGED_TAG_MAPPINGS.as_bytes()),
    ),
    (
      1028,
      "document graph reference scope",
      sha384(DOCUMENT_GRAPH_REFERENCE_SCOPE.as_bytes()),
    ),
    (
      1029,
      "database template owned content",
      sha384(DATABASE_TEMPLATE_OWNED_CONTENT.as_bytes()),
    ),
    (
      1030,
      "history reference origin",
      sha384(HISTORY_REFERENCE_ORIGIN.as_bytes()),
    ),
    (
      1031,
      "document change batches",
      sha384(DOCUMENT_CHANGE_BATCHES.as_bytes()),
    ),
    (
      1032,
      "workspace content precise conditions",
      sha384(WORKSPACE_CONTENT_PRECISE_CONDITIONS.as_bytes()),
    ),
    (1033, "calendar mail intent", sha384(CALENDAR_MAIL_INTENT.as_bytes())),
    (
      1034,
      "calendar mail scope index",
      sha384(CALENDAR_MAIL_SCOPE_INDEX.as_bytes()),
    ),
    (1035, "audio job results", sha384(AUDIO_JOB_RESULTS.as_bytes())),
    (1036, "audio job attempts", sha384(AUDIO_JOB_ATTEMPTS.as_bytes())),
    (
      1037,
      "workspace automation job identity",
      sha384(AUTOMATION_JOB_IDENTITY.as_bytes()),
    ),
    (
      1038,
      "mcp document payload format",
      sha384(MCP_DOCUMENT_PAYLOAD_FORMAT.as_bytes()),
    ),
    (
      1039,
      "document status okf mapping",
      sha384(DOCUMENT_STATUS_OKF_MAPPING.as_bytes()),
    ),
    (
      1040,
      "workspace content workspace deletion",
      sha384(WORKSPACE_CONTENT_WORKSPACE_DELETION.as_bytes()),
    ),
    (1041, "database task capture", sha384(DATABASE_TASK_CAPTURE.as_bytes())),
    (
      1042,
      "database task notification intent",
      sha384(DATABASE_TASK_NOTIFICATION_INTENT.as_bytes()),
    ),
    (
      1043,
      "managed database schema",
      sha384(MANAGED_DATABASE_SCHEMA.as_bytes()),
    ),
    (1044, "task move constraints", sha384(TASK_MOVE_CONSTRAINTS.as_bytes())),
    (
      1045,
      "workspace starter applications",
      sha384(WORKSPACE_STARTER_APPLICATIONS.as_bytes()),
    ),
    (
      1046,
      "template default release ownership",
      sha384(TEMPLATE_DEFAULT_RELEASE_OWNERSHIP.as_bytes()),
    ),
    (
      1047,
      "template revision publication ownership",
      sha384(TEMPLATE_REVISION_PUBLICATION_OWNERSHIP.as_bytes()),
    ),
    (
      1048,
      "database row template revisions",
      sha384(DATABASE_ROW_TEMPLATE_REVISIONS.as_bytes()),
    ),
    (
      1049,
      "workspace project starters",
      sha384(WORKSPACE_PROJECT_STARTERS.as_bytes()),
    ),
    (
      1050,
      "workspace project components",
      sha384(WORKSPACE_PROJECT_COMPONENTS.as_bytes()),
    ),
    (
      1051,
      "workspace project purpose",
      sha384(WORKSPACE_PROJECT_PURPOSE.as_bytes()),
    ),
    (
      1052,
      "context document starters",
      sha384(CONTEXT_DOCUMENT_STARTERS.as_bytes()),
    ),
    (
      1053,
      "workspace automation runtime",
      sha384(WORKSPACE_AUTOMATION_RUNTIME.as_bytes()),
    ),
    (
      1054,
      "context document workflows",
      sha384(CONTEXT_DOCUMENT_WORKFLOWS.as_bytes()),
    ),
    (
      1055,
      "document review workflows",
      sha384(DOCUMENT_REVIEW_WORKFLOWS.as_bytes()),
    ),
    (
      1056,
      "workspace automation signal outbox",
      sha384(WORKSPACE_AUTOMATION_SIGNAL_OUTBOX.as_bytes()),
    ),
    (
      1057,
      "task handover workflows",
      sha384(TASK_HANDOVER_WORKFLOWS.as_bytes()),
    ),
    (
      1058,
      "automation effect consolidation",
      sha384(AUTOMATION_EFFECT_CONSOLIDATION.as_bytes()),
    ),
    (1059, "task assistance", sha384(TASK_ASSISTANCE.as_bytes())),
    (
      1060,
      "workspace setup workflows",
      sha384(WORKSPACE_SETUP_WORKFLOWS.as_bytes()),
    ),
    (
      1061,
      "workspace overview settings",
      sha384(WORKSPACE_OVERVIEW_SETTINGS.as_bytes()),
    ),
    (
      1062,
      "document initial metadata projection",
      sha384(DOCUMENT_INITIAL_METADATA_PROJECTION.as_bytes()),
    ),
    (
      1063,
      "copilot response anchors",
      sha384(COPILOT_RESPONSE_ANCHORS.as_bytes()),
    ),
    (
      1064,
      "copilot context metadata",
      sha384(COPILOT_CONTEXT_METADATA.as_bytes()),
    ),
    (
      1065,
      "copilot context ingestion due",
      sha384(COPILOT_CONTEXT_INGESTION_DUE.as_bytes()),
    ),
    (
      1066,
      "copilot embedding dimensions",
      sha384(COPILOT_EMBEDDING_DIMENSIONS.as_bytes()),
    ),
    (
      1067,
      "git sync profile scopes",
      sha384(GIT_SYNC_PROFILE_SCOPES.as_bytes()),
    ),
    (
      1068,
      "git sync shared credential lifetime",
      sha384(GIT_SYNC_SHARED_CREDENTIAL_LIFETIME.as_bytes()),
    ),
    (
      1069,
      "workspace content extract git plan",
      sha384(WORKSPACE_CONTENT_EXTRACT_GIT_PLAN.as_bytes()),
    ),
    (
      1070,
      "workspace content extract git pending",
      sha384(WORKSPACE_CONTENT_EXTRACT_GIT_PENDING.as_bytes()),
    ),
    (
      1071,
      "workspace content extract git guards",
      sha384(WORKSPACE_CONTENT_EXTRACT_GIT_GUARDS.as_bytes()),
    ),
    (
      1072,
      "workspace content extract git commit",
      sha384(WORKSPACE_CONTENT_EXTRACT_GIT_COMMIT.as_bytes()),
    ),
    (
      1073,
      "git sync verified extract capture",
      sha384(GIT_SYNC_VERIFIED_EXTRACT_CAPTURE.as_bytes()),
    ),
    (
      1074,
      "workspace content extract profile admission",
      sha384(WORKSPACE_CONTENT_EXTRACT_PROFILE_ADMISSION.as_bytes()),
    ),
    (
      1075,
      "extract disconnect profile repair",
      sha384(EXTRACT_DISCONNECT_PROFILE_REPAIR.as_bytes()),
    ),
    (
      1076,
      "workspace content git undo receipt",
      sha384(WORKSPACE_CONTENT_GIT_UNDO_RECEIPT.as_bytes()),
    ),
    (
      1077,
      "git sync open conflict identity",
      sha384(GIT_SYNC_OPEN_CONFLICT_IDENTITY.as_bytes()),
    ),
    (1078, "scheduling admission", sha384(SCHEDULING_ADMISSION.as_bytes())),
    (
      1079,
      "task recurrence series",
      sha384(TASK_RECURRENCE_SERIES.as_bytes()),
    ),
    (
      1080,
      "task recurrence completion",
      sha384(TASK_RECURRENCE_COMPLETION.as_bytes()),
    ),
    (1081, "guide template state", sha384(GUIDE_TEMPLATE_STATE.as_bytes())),
    (
      1082,
      "task recurrence lifecycle",
      sha384(TASK_RECURRENCE_LIFECYCLE.as_bytes()),
    ),
    (
      1083,
      "calendar timing definitions",
      sha384(CALENDAR_TIMING_DEFINITIONS.as_bytes()),
    ),
    (
      1084,
      "calendar series boundaries",
      sha384(CALENDAR_SERIES_BOUNDARIES.as_bytes()),
    ),
    (
      1085,
      "calendar pause intervals",
      sha384(CALENDAR_PAUSE_INTERVALS.as_bytes()),
    ),
    (
      1086,
      "calendar source context",
      sha384(CALENDAR_SOURCE_CONTEXT.as_bytes()),
    ),
    (
      1087,
      "document review planning",
      sha384(DOCUMENT_REVIEW_PLANNING.as_bytes()),
    ),
    (
      1088,
      "document review cycle admission",
      sha384(DOCUMENT_REVIEW_CYCLE_ADMISSION.as_bytes()),
    ),
    (
      1089,
      "document review generation",
      sha384(DOCUMENT_REVIEW_GENERATION.as_bytes()),
    ),
    (
      1090,
      "calendar reminder admission",
      sha384(CALENDAR_REMINDER_ADMISSION.as_bytes()),
    ),
    (
      1091,
      "database reminder admission",
      sha384(DATABASE_REMINDER_ADMISSION.as_bytes()),
    ),
    (1092, "git cron admission", sha384(GIT_CRON_ADMISSION.as_bytes())),
    (1093, "git polling admission", sha384(GIT_POLLING_ADMISSION.as_bytes())),
    (
      1094,
      "git rotation admission",
      sha384(GIT_ROTATION_ADMISSION.as_bytes()),
    ),
    (1095, "registered job import", sha384(REGISTERED_JOB_IMPORT.as_bytes())),
    (
      1096,
      "registered job admission",
      sha384(REGISTERED_JOB_ADMISSION.as_bytes()),
    ),
  ]
}

async fn assert_current_ledger(pool: &PgPool) {
  let actual = ledger_snapshot(pool).await;
  let expected = expected_ledger();
  assert_eq!(actual.len(), expected.len());
  for ((version, description, success, checksum), expected) in actual.iter().zip(expected) {
    assert_eq!(
      (*version, description.as_str(), *success),
      (expected.0, expected.1, true)
    );
    assert_eq!(checksum.as_slice(), expected.2.as_slice());
  }
}

async fn assert_forward_schema(pool: &PgPool) {
  let scope_contract: (bool, bool, bool, bool, bool) = sqlx::query_as(
    "SELECT
       (SELECT column_default LIKE '%git-sync-manifest.json%' FROM information_schema.columns
        WHERE table_schema='public' AND table_name='git_sync_profiles' AND column_name='manifest_path'),
       (SELECT column_default LIKE '%0%' FROM information_schema.columns
        WHERE table_schema='public' AND table_name='git_sync_profiles' AND column_name='scope_revision'),
       EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='git_sync_scope_exclusions'::regclass
         AND conname='git_sync_scope_exclusions_profile_id_fkey' AND confdeltype='c'),
       EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='git_sync_scope_exclusions'::regclass
         AND conname='git_sync_scope_exclusions_destination_profile_id_fkey' AND confdeltype='n'),
       NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='git_sync_scope_exclusions'::regclass
         AND conname LIKE '%originating_operation%')",
  )
  .fetch_one(pool)
  .await
  .expect("read Git-Sync profile scope migration contract");
  assert_eq!(scope_contract, (true, true, true, true, true));
  let lifetime_guard: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM pg_constraint
     WHERE conrelid = 'git_sync_profiles'::regclass
       AND conname = 'git_sync_profiles_active_credential_fkey'
       AND condeferrable AND condeferred AND convalidated AND confdeltype = 'a')",
  )
  .fetch_one(pool)
  .await
  .expect("read shared credential lifetime guard");
  assert!(lifetime_guard);
  let contextual_receipt_contract:(bool,bool)=sqlx::query_as(
    "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
      AND conname='workspace_starter_applications_operation_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%prepare_documents%'),
     EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
      AND conname='workspace_starter_applications_context_documents_check' AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%projectCreated%' AND pg_get_constraintdef(oid) LIKE '%false%'
      AND pg_get_constraintdef(oid) LIKE '%target%' AND pg_get_constraintdef(oid) LIKE '%jsonb_array_length%')"
  ).fetch_one(pool).await.expect("same ledger supports bounded documents without a Project ACK");
  assert_eq!(contextual_receipt_contract, (true, true));
  let starter_columns: Vec<(String, String, String)> = sqlx::query_as(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='workspace_starter_applications'
       AND column_name IN ('project_plan','project_result_ids','project_admission','project_state','project_progress','workspace_plan')
     ORDER BY column_name",
  )
  .fetch_all(pool)
  .await
  .expect("read optional Project plans and component progress on the existing Workspace ledger");
  assert_eq!(
    starter_columns,
    [
      ("project_admission", "jsonb", "YES"),
      ("project_plan", "jsonb", "YES"),
      ("project_progress", "jsonb", "YES"),
      ("project_result_ids", "jsonb", "YES"),
      ("project_state", "text", "YES"),
      ("workspace_plan", "jsonb", "YES"),
    ]
    .map(|(name, kind, nullable)| (name.to_owned(), kind.to_owned(), nullable.to_owned()))
  );
  let starter_identity_contract: (bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='workspace_starter_applications_created_workspace_unique'::regclass
       AND indrelid='workspace_starter_applications'::regclass AND indisunique
       AND pg_get_indexdef(indexrelid) LIKE '%(workspace_id)%'
       AND pg_get_expr(indpred,indrelid) LIKE '%operation = %create_workspace%'),
     NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
       AND conname='workspace_starter_applications_workspace_id_key'),
     EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
       AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (actor_id, operation, request_id)')",
  )
  .fetch_one(pool)
  .await
  .expect("read operation-scoped request identity and allocation-only Workspace uniqueness");
  assert_eq!(starter_identity_contract, (true, true, true));
  let starter_plan_contract: (bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
       AND conname='workspace_starter_applications_operation_check' AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%create_workspace%' AND pg_get_constraintdef(oid) LIKE '%create_project%'),
     EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
       AND conname='workspace_starter_applications_workspace_plan_check' AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%create_workspace%' AND pg_get_constraintdef(oid) LIKE '%4194304%'),
     EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_starter_applications'::regclass
       AND conname='workspace_starter_applications_project_shape' AND convalidated
       AND pg_get_constraintdef(oid) LIKE '%workspace_plan%project%'
       AND pg_get_constraintdef(oid) LIKE '%project_result_ids IS NOT NULL%'
       AND pg_get_constraintdef(oid) LIKE '%project_admission IS NOT NULL%'
       AND pg_get_constraintdef(oid) LIKE '%project_progress IS NOT NULL%'
       AND pg_get_constraintdef(oid) LIKE '%stop_requested%'
       AND pg_get_constraintdef(oid) LIKE '%32768%'
       AND pg_get_constraintdef(oid) LIKE '%8192%'
       AND pg_get_constraintdef(oid) LIKE '%131072%')",
  )
  .fetch_one(pool)
  .await
  .expect("read bounded composed/unbound Project plans and mandatory native progress guards");
  assert_eq!(starter_plan_contract, (true, true, true));

  let capture_contract: (bool, bool, i64, i64) = sqlx::query_as(
    "SELECT to_regclass('public.database_row_source_links') IS NOT NULL, to_regclass('public.database_task_capture_receipts') IS NOT NULL, (SELECT count(*) FROM pg_constraint WHERE conrelid='database_task_capture_receipts'::regclass AND contype='f' AND confrelid IN ('users'::regclass,'workspaces'::regclass) AND confdeltype='c'), (SELECT count(*) FROM pg_constraint WHERE conrelid='database_task_capture_receipts'::regclass AND contype='f' AND confrelid IN ('workspace_database_rows'::regclass,'workspace_databases'::regclass,'docs'::regclass))",
  ).fetch_one(pool).await.expect("capture tables and purge-surviving receipt foreign keys");
  assert_eq!(capture_contract, (true, true, 2, 0));

  let okf_contract: (bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='document_status_value' AND column_name='okf_status' AND is_nullable='NO' AND column_default LIKE '%draft%'), EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='document_status_value'::regclass AND conname='document_status_value_okf_status_check' AND convalidated), NOT EXISTS(SELECT 1 FROM document_status_value WHERE okf_status <> CASE WHEN key IN ('current','approved','released','active') THEN 'stable' WHEN key IN ('outdated','superseded','obsolete','archived') THEN 'deprecated' ELSE 'draft' END)",
  ).fetch_one(pool).await.expect("constrained OKF column and initial preset mappings");
  assert_eq!(okf_contract, (true, true, true));
  let terminal_contract: (bool, bool, bool) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_deleted_account_shape' AND convalidated), EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='sessions'::regclass AND tgname='guard_account_user_id' AND tgenabled='O'), NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('comments'::regclass,'comment_attachments'::regclass,'workspace_invite_links'::regclass) AND tgfoid='guard_operational_account_reference()'::regprocedure)")
    .fetch_one(pool).await.expect("terminal identity and operational-only guard schema");
  assert_eq!(terminal_contract, (true, true, true));

  let forward_contract: (bool, bool, bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspace_database_views_view_kind_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%gantt%'), to_regclass('public.git_token_rotation') IS NOT NULL, to_regclass('public.workspace_tag_retired_ids') IS NOT NULL, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workspaces' AND column_name='description' AND is_nullable='NO' AND column_default IS NOT NULL), EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workspaces_description_length' AND convalidated AND pg_get_constraintdef(oid) LIKE '%char_length(description) <= 2000%')",
  )
  .fetch_one(pool)
  .await
  .expect("read regular forward-migration contract");
  assert_eq!(forward_contract, (true, true, true, true, true));
  let calendar_delete_contract: (bool, bool) = sqlx::query_as(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='calendar_pending_writes' AND column_name='event_id' AND is_nullable='YES'), EXISTS (SELECT 1 FROM pg_constraint WHERE conname='calendar_pending_writes_detached_delete_check' AND convalidated)",
  )
  .fetch_one(pool)
  .await
  .expect("read detached calendar delete migration contract");
  assert_eq!(calendar_delete_contract, (true, true));
  let history_capture_contract: (bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='document_versioning_workspace_settings' AND column_name='edit_capture_enabled' AND is_nullable='YES'), EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='document_versioning_workspace_settings' AND column_name='edit_capture_interval_ms' AND is_nullable='YES'), EXISTS (SELECT 1 FROM pg_constraint WHERE conname='document_versioning_workspace_settings_edit_capture_interval_check' AND convalidated)",
  )
  .fetch_one(pool)
  .await
  .expect("read document-history edit-capture migration contract");
  assert_eq!(history_capture_contract, (true, true, true));
  let history_provenance_contract: (bool, bool, bool, bool) = sqlx::query_as(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='doc_histories' AND column_name='origin' AND is_nullable='YES'), EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='doc_histories' AND column_name='actor_id' AND is_nullable='YES'), EXISTS (SELECT 1 FROM pg_constraint WHERE conname='doc_histories_origin_check' AND convalidated), EXISTS (SELECT 1 FROM pg_constraint WHERE conname='doc_histories_actor_id_fkey' AND confdeltype='n')",
  )
  .fetch_one(pool)
  .await
  .expect("read document-history provenance migration contract");
  assert_eq!(history_provenance_contract, (true, true, true, true));
  let edit_capture_due_contract: (bool, bool, bool, bool) = sqlx::query_as(
    "SELECT to_regclass('public.document_edit_capture_state') IS NOT NULL,
            to_regclass('public.document_edit_capture_state_due_idx') IS NOT NULL,
            to_regclass('public.document_edit_capture_runtime') IS NOT NULL,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname='document_edit_capture_state_doc_id_fkey' AND confdeltype='c')",
  )
  .fetch_one(pool)
  .await
  .expect("read document edit-capture due-state contract");
  assert_eq!(edit_capture_due_contract, (true, true, true, true));
  let guide_contract: Vec<(String, i32, String)> = sqlx::query_as(
    "SELECT e.slug, e.builder_version, p.provisioning_mode FROM template_catalog_entries e JOIN template_default_policies p ON p.template_id = e.id WHERE e.source = 'builtin' AND e.slug IN ('agile-retro', 'agile-standup', 'databases-guide-myoxus', 'getting-started-myoxus', 'meeting-notes', 'meeting-templates-myoxus', 'using-folders-myoxus', 'welcome-myoxus') ORDER BY e.slug",
  )
  .fetch_all(pool)
  .await
  .expect("read meeting and onboarding registry contracts");
  assert_eq!(
    guide_contract,
    [
      ("agile-retro", 4, "managed_until_local_edit"),
      ("agile-standup", 4, "managed_until_local_edit"),
      ("databases-guide-myoxus", 2, "seed_once"),
      ("getting-started-myoxus", 4, "seed_once"),
      ("meeting-notes", 4, "managed_until_local_edit"),
      ("meeting-templates-myoxus", 3, "seed_once"),
      ("using-folders-myoxus", 3, "seed_once"),
      ("welcome-myoxus", 4, "seed_once"),
    ]
    .map(|(slug, version, policy)| (slug.to_owned(), version, policy.to_owned()))
  );
}

#[tokio::test]
async fn fresh_database_reaches_current_schema_idempotently() {
  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let pool = harness.create("fresh").await?;
    pools.push(pool.clone());
    let empty = myoxus_infrastructure::migrations::inspect(&pool).await.unwrap();
    assert_eq!(empty.ledger_class, "empty");
    assert_eq!(empty.highest_applied, None);
    assert_eq!(empty.pending_versions.first(), Some(&1000));
    assert!(
      relation_snapshot(&pool).await.is_empty(),
      "inspection must not create even the ledger"
    );
    myoxus_infrastructure::migrations::run(&pool).await.unwrap();
    assert_current_ledger(&pool).await;
    assert_forward_schema(&pool).await;
    let relations = relation_snapshot(&pool).await;
    let ledger = ledger_snapshot(&pool).await;
    let current = myoxus_infrastructure::migrations::inspect(&pool).await.unwrap();
    assert!(current.pending_versions.is_empty());
    assert_eq!(current.highest_applied, ledger.last().map(|entry| entry.0));
    assert_eq!(ledger_snapshot(&pool).await, ledger);
    assert_eq!(relation_snapshot(&pool).await, relations);

    myoxus_infrastructure::migrations::run(&pool).await.unwrap();
    assert_current_ledger(&pool).await;
    assert_eq!(relation_snapshot(&pool).await, relations);
    Ok::<(), sqlx::Error>(())
  })
  .catch_unwind()
  .await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("clean fresh migration database");
  match result {
    Ok(result) => result.expect("verify fresh and idempotent migration path"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}

// Existing pending receipts have unknown effects. Migration must retain them
// without granting the new transaction-backed recovery guarantee retroactively.
async fn seed_legacy_mcp_receipts(pool: &PgPool) -> Result<(Uuid, Uuid, Uuid), sqlx::Error> {
  let user = Uuid::new_v4();
  let key = Uuid::new_v4();
  let pending = Uuid::new_v4();
  sqlx::query("INSERT INTO users(id,email,name) VALUES ($1,$2,'Legacy MCP')")
    .bind(user)
    .bind(format!("legacy-mcp-{user}@test.invalid"))
    .execute(pool)
    .await?;
  sqlx::query(
    "INSERT INTO api_keys(id,user_id,name,key_hash,scopes) VALUES ($1,$2,'Legacy MCP',$3,ARRAY['write:docs'])",
  )
  .bind(key)
  .bind(user)
  .bind(format!("fixture-{key}"))
  .execute(pool)
  .await?;
  for (id, label, response) in [
    (pending, "pending", None),
    (Uuid::new_v4(), "completed", Some(serde_json::json!({"content":[]}))),
  ] {
    sqlx::query("INSERT INTO mcp_idempotency_keys(id,api_key_id,user_id,tool_name,idempotency_key,payload_sha256,response_json) VALUES ($1,$2,$3,'create_page',$4,$5,$6)")
      .bind(id).bind(key).bind(user).bind(label).bind("a".repeat(64)).bind(response).execute(pool).await?;
  }
  Ok((user, key, pending))
}

async fn assert_legacy_mcp_receipts_preserved(pool: &PgPool, user: Uuid, key: Uuid, pending: Uuid) {
  use myoxus_application::mcp::{McpIdempotencyAdmission, McpIdempotencyRepository};
  let flags: Vec<(bool, bool)> =
    sqlx::query_as("SELECT recovery_enabled,mutation_committed FROM mcp_idempotency_keys WHERE api_key_id=$1")
      .bind(key)
      .fetch_all(pool)
      .await
      .expect("legacy recovery flags");
  assert_eq!(flags, vec![(false, false); 2]);
  sqlx::query("UPDATE mcp_idempotency_keys SET lease_until=now()-interval '1 second' WHERE api_key_id=$1")
    .bind(key)
    .execute(pool)
    .await
    .expect("expire legacy fixture lease");
  let repository = myoxus_infrastructure::mcp_idempotency::SqlxMcpIdempotencyRepository::new(pool.clone());
  for label in ["pending", "completed"] {
    let admission = repository
      .begin(Uuid::new_v4(), key, user, "create_page", label, &"a".repeat(64), 1)
      .await
      .expect("legacy admission remains readable");
    let McpIdempotencyAdmission::Existing {
      payload_sha256,
      document_payload_format,
      response,
    } = admission
    else {
      panic!("legacy admission must never be executed again")
    };
    assert_eq!(payload_sha256, "a".repeat(64));
    assert_eq!(
      document_payload_format, 0,
      "forward migration preserves historical receipt format"
    );
    assert_eq!(
      response,
      if label == "completed" {
        Some(serde_json::json!({"content":[]}))
      } else {
        None
      }
    );
  }
  let preserved: Uuid =
    sqlx::query_scalar("SELECT id FROM mcp_idempotency_keys WHERE api_key_id=$1 AND idempotency_key='pending'")
      .bind(key)
      .fetch_one(pool)
      .await
      .expect("unchanged pending identity");
  assert_eq!(preserved, pending);
}

#[tokio::test]
async fn baseline_1000_advances_through_regular_forward_migrations() {
  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let pool = harness.create("forward").await?;
    pools.push(pool.clone());
    install_baseline_1000(&pool).await?;
    let stale_search_row_id = seed_stale_database_tag_search_payload(&pool).await?;
    let (legacy_user,legacy_key,legacy_pending)=seed_legacy_mcp_receipts(&pool).await?;
    let guide_workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'Guide classification fixture')").bind(guide_workspace).execute(&pool).await?;
    let mut guide_cases = Vec::new();
    for (legacy, purpose, existing_state, expected_state) in [(true,"guide",None,"guide"), (false,"guide",Some("managed"),"guide"), (false,"template",None,"managed"), (false,"template",Some("detached"),"detached")] {
      let doc = Uuid::new_v4();
      let template = Uuid::new_v4();
      let revision = Uuid::new_v4();
      let key = format!("guide-index-{doc}");
      sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title) VALUES($1,$2,$3,'Same arbitrary title')")
        .bind(doc).bind(guide_workspace).bind(&key).execute(&pool).await?;
      sqlx::query("INSERT INTO template_catalog_entries(id,slug,title,source,category) VALUES($1,$2,'Same arbitrary title','bundle',$3)")
        .bind(template).bind(format!("guide-index-{template}")).bind(if legacy || purpose == "template" {"onboarding"} else {"arbitrary-category"}).execute(&pool).await?;
      if !legacy {
        sqlx::query("INSERT INTO template_revisions(id,template_id,version,manifest_json) VALUES($1,$2,'1.0.0',$3)")
          .bind(revision).bind(template).bind(serde_json::json!({"purpose":purpose})).execute(&pool).await?;
      }
      sqlx::query("INSERT INTO workspace_template_instances(workspace_id,template_id,revision_id,workspace_doc_id,workspace_doc_key) VALUES($1,$2,$3,$4,$5)")
        .bind(guide_workspace).bind(template).bind(if legacy {None} else {Some(revision)})
        .bind(if legacy {None} else {Some(doc)}).bind(&key).execute(&pool).await?;
      if let Some(state) = existing_state {
        sqlx::query("INSERT INTO document_template_state(doc_id,state) VALUES($1,$2)").bind(doc).bind(state).execute(&pool).await?;
      }
      guide_cases.push((doc,Some(expected_state.to_string())));
    }


    let ordinary_doc = Uuid::new_v4();
    sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title) VALUES($1,$2,$1::text,'Same arbitrary title')")
      .bind(ordinary_doc).bind(guide_workspace).execute(&pool).await?;
    guide_cases.push((ordinary_doc,None));

    assert_eq!(ledger_snapshot(&pool).await.len(), 1);

    let before_inspection = ledger_snapshot(&pool).await;
    let before_relations = relation_snapshot(&pool).await;
    let pending = myoxus_infrastructure::migrations::inspect(&pool).await.unwrap();
    assert_eq!(pending.ledger_class, "baseline");
    assert_eq!(pending.highest_applied, Some(1000));
    assert_eq!(pending.pending_versions, expected_ledger().iter().skip(1).map(|entry| entry.0).collect::<Vec<_>>());
    assert_eq!(ledger_snapshot(&pool).await, before_inspection);
    assert_eq!(relation_snapshot(&pool).await, before_relations);

    myoxus_infrastructure::migrations::run(&pool).await.unwrap();
    assert_current_ledger(&pool).await;
    assert_forward_schema(&pool).await;
    assert_legacy_mcp_receipts_preserved(&pool,legacy_user,legacy_key,legacy_pending).await;
    for (doc, expected_state) in guide_cases {
      let (state,title): (Option<String>,String) = sqlx::query_as("SELECT native.state,d.title FROM docs d LEFT JOIN document_template_state native ON native.doc_id=d.id WHERE d.id=$1")
        .bind(doc).fetch_one(&pool).await?;
      assert_eq!(state,expected_state,"classify only delivery metadata; preserve existing custom source states");
      assert_eq!(title,"Same arbitrary title");
    }

    let (search_text, stale_tag_match, visible_text_match): (String, bool, bool) = sqlx::query_as(
      "SELECT search_text, tsv @@ plainto_tsquery('simple', 'RetiredTag'), tsv @@ plainto_tsquery('simple', 'Visible payload') FROM workspace_database_row_search WHERE row_id = $1",
    )
    .bind(stale_search_row_id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(search_text, "Visible payload");
    assert!(!stale_tag_match, "migration must remove stale deleted-Tag tokens");
    assert!(visible_text_match, "migration must preserve non-Tag cell searchability");

    let released = harness.create("released1044").await?;
    pools.push(released.clone());
    install_baseline_1000(&released).await?;
    let expected = expected_ledger();
    for path in sql_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")) {
      let version = migration_version(&path);
      if !(1001..=1044).contains(&version) { continue; }
      let source = std::fs::read_to_string(&path).expect("read released migration fixture");
      sqlx::raw_sql(&source).execute(&released).await?;
      let (_,description,checksum) = expected.iter().find(|entry|entry.0==version).expect("known released ledger entry");
      sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)")
        .bind(version).bind(description).bind(checksum).execute(&released).await?;
    }
    assert_eq!(ledger_snapshot(&released).await.last().unwrap().0,1044);
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'Preserved1044')").bind(workspace).execute(&released).await?;
    let before: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(w) FROM workspaces w WHERE id=$1")
      .bind(workspace).fetch_one(&released).await?;
    myoxus_infrastructure::migrations::run(&released).await.expect("unchanged released1044 ledger upgrades to current inventory");
    assert_current_ledger(&released).await;
    assert_forward_schema(&released).await;
    let mut after: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(w) FROM workspaces w WHERE id=$1")
      .bind(workspace).fetch_one(&released).await?;
    assert_eq!(after.as_object_mut().unwrap().remove("initial_content_policy"),Some(serde_json::json!("legacy_defaults")));
    assert_eq!(after.as_object_mut().unwrap().remove("overview_settings"),Some(serde_json::json!({})));
    assert_eq!(after.as_object_mut().unwrap().remove("overview_revision"),Some(serde_json::json!(0)));
    assert_eq!(after,before,"forward migration must preserve every existing Workspace fact");
    let migrated = ledger_snapshot(&released).await;
    myoxus_infrastructure::migrations::run(&released).await.expect("released1044 upgrade is idempotent");
    assert_eq!(ledger_snapshot(&released).await,migrated);

    // Shared constraint extensions must preserve populated native rule shapes,
    // not only accept a fresh database with no scheduling sources yet.
    let scheduled=harness.create("scheduled1094").await?;
    pools.push(scheduled.clone());
    install_baseline_1000(&scheduled).await?;
    for path in sql_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")){
      let version=migration_version(&path);
      if !(1001..=1094).contains(&version){continue;}
      let source=std::fs::read_to_string(&path).expect("read native scheduling upgrade fixture");
      sqlx::raw_sql(&source).execute(&scheduled).await?;
      let (_,description,checksum)=expected.iter().find(|entry|entry.0==version).expect("known native scheduling ledger");
      sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)")
        .bind(version).bind(description).bind(checksum).execute(&scheduled).await?;
    }
    use myoxus_domain::scheduling::{AdmissionZone,RecurrenceRule,RecurrenceSelector,RelativeInterval,RelativeUnit,ScheduleRule,ScheduleTarget,ScheduleValue,calendar::CalendarTimingRule};
    let workspace=Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'Existing native scheduling sources')").bind(workspace).execute(&scheduled).await?;
    let zone=AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap();
    let completion=Uuid::new_v4();
    let fixed=Uuid::new_v4();
    let imported=Uuid::new_v4();
    let sources=[
      (completion,serde_json::to_value(ScheduleTarget::RecurringTask{series_id:completion}).unwrap(),serde_json::to_value(ScheduleRule::AfterCompletion{interval:RelativeInterval{amount:std::num::NonZeroU32::new(1).unwrap(),unit:RelativeUnit::Days},date_only:true}).unwrap()),
      (fixed,serde_json::to_value(ScheduleTarget::CalendarMaster{event_id:Uuid::new_v4()}).unwrap(),serde_json::to_value(CalendarTimingRule::Fixed{rule:RecurrenceRule{selector:RecurrenceSelector::Daily,interval:std::num::NonZeroU32::new(1).unwrap(),start:ScheduleValue::Date(chrono::NaiveDate::from_ymd_opt(2026,11,2).unwrap()),end:None,zone}}).unwrap()),
      (imported,serde_json::to_value(ScheduleTarget::CalendarMaster{event_id:Uuid::new_v4()}).unwrap(),serde_json::to_value(CalendarTimingRule::ImportedCalendar{rrule:"FREQ=DAILY;COUNT=3".into(),starts_at:chrono::DateTime::parse_from_rfc3339("2026-11-02T09:00:00Z").unwrap().with_timezone(&chrono::Utc),all_day:false,zone}).unwrap()),
    ];
    for (id,target,rule) in sources{
      sqlx::query("INSERT INTO scheduling_schedules(id,workspace_id,admission_zone,target_json,rule_json) VALUES($1,$2,'Europe/Berlin',$3,$4)")
        .bind(id).bind(workspace).bind(target).bind(rule).execute(&scheduled).await?;
    }
    let before:serde_json::Value=sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM scheduling_schedules s WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&scheduled).await?;
    myoxus_infrastructure::migrations::run(&scheduled).await.expect("existing native completion and Calendar rules must upgrade unchanged");
    assert_current_ledger(&scheduled).await;
    let after:serde_json::Value=sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM scheduling_schedules s WHERE workspace_id=$1")
      .bind(workspace).fetch_one(&scheduled).await?;
    assert_eq!(after,before,"a registered-worker cutover cannot rewrite existing Task/Calendar rule facts");
    Ok::<(), sqlx::Error>(())
  }).catch_unwind().await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("clean forward-migration database");
  match result {
    Ok(result) => result.expect("verify baseline forward-migration path"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}

#[tokio::test]
async fn concurrent_baseline_starts_apply_forward_chain_once() {
  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let pool = harness.create("concurrent").await?;
    pools.push(pool.clone());
    install_baseline_1000(&pool).await?;
    let (first, second) = tokio::join!(
      myoxus_infrastructure::migrations::run(&pool),
      myoxus_infrastructure::migrations::run(&pool)
    );
    first.unwrap();
    second.unwrap();
    assert_current_ledger(&pool).await;
    assert_forward_schema(&pool).await;
    Ok::<(), sqlx::Error>(())
  })
  .catch_unwind()
  .await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("clean concurrent migration database");
  match result {
    Ok(result) => result.expect("verify concurrent forward migration"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}

#[tokio::test]
async fn old_unknown_and_corrupt_ledgers_fail_closed_without_persistent_writes() {
  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let old = harness.create("oldledger").await?;
    pools.push(old.clone());
    create_migrations_table(&old).await?;
    sqlx::query(
      "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (237,'old release ledger',TRUE,$1,0)",
    )
    .bind(vec![7_u8; 48])
    .execute(&old)
    .await?;
    let old_ledger = ledger_snapshot(&old).await;
    let old_relations = relation_snapshot(&old).await;
    let error = myoxus_infrastructure::migrations::inspect(&old).await.expect_err("inspection rejects old ledgers without writing");
    assert!(error.to_string().contains("class=unknown-pre-baseline-ledger"));
    assert_eq!(ledger_snapshot(&old).await, old_ledger);
    assert_eq!(relation_snapshot(&old).await, old_relations);
    let error = myoxus_infrastructure::migrations::run(&old)
      .await
      .expect_err("an old pre-baseline ledger must be unsupported");
    let message = error.to_string();
    assert!(message.contains("class=unknown-pre-baseline-ledger"), "{message}");
    assert!(message.contains("highest=237"), "{message}");
    assert_eq!(ledger_snapshot(&old).await, old_ledger);
    assert_eq!(relation_snapshot(&old).await, old_relations);

    let corrupt = harness.create("corruptbaseline").await?;
    pools.push(corrupt.clone());
    install_baseline_1000(&corrupt).await?;
    sqlx::query("UPDATE _sqlx_migrations SET checksum=$1 WHERE version=1000")
      .bind(vec![8_u8; 48])
      .execute(&corrupt)
      .await?;
    let corrupt_ledger = ledger_snapshot(&corrupt).await;
    let corrupt_relations = relation_snapshot(&corrupt).await;
    let error = myoxus_infrastructure::migrations::inspect(&corrupt).await.expect_err("inspection rejects changed checksums without writing");
    assert!(error.to_string().contains("class=invalid-baseline-ledger"));
    assert_eq!(ledger_snapshot(&corrupt).await, corrupt_ledger);
    assert_eq!(relation_snapshot(&corrupt).await, corrupt_relations);
    let error = myoxus_infrastructure::migrations::run(&corrupt)
      .await
      .expect_err("an altered baseline ledger must be unsupported");
    let message = error.to_string();
    assert!(message.contains("class=invalid-baseline-ledger"), "{message}");
    assert!(message.contains("highest=1000"), "{message}");
    assert_eq!(ledger_snapshot(&corrupt).await, corrupt_ledger);
    assert_eq!(relation_snapshot(&corrupt).await, corrupt_relations);

    let untracked = harness.create("schemawithoutledger").await?;
    pools.push(untracked.clone());
    sqlx::query("CREATE TABLE untracked_domain_state (id BIGINT PRIMARY KEY)")
      .execute(&untracked)
      .await?;
    let relations = relation_snapshot(&untracked).await;
    let error = myoxus_infrastructure::migrations::run(&untracked)
      .await
      .expect_err("a non-empty schema without a ledger must be unsupported");
    let message = error.to_string();
    assert!(message.contains("class=schema-without-ledger"), "{message}");
    assert!(message.contains("highest=none"), "{message}");
    assert_eq!(relation_snapshot(&untracked).await, relations);
    assert!(
      !sqlx::query_scalar::<_, bool>("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
        .fetch_one(&untracked)
        .await?
    );
    Ok::<(), sqlx::Error>(())
  }).catch_unwind().await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("clean rejected migration databases");
  match result {
    Ok(result) => result.expect("verify fail-closed ledger preflight"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}

#[tokio::test]
async fn damaged_current_schema_fails_without_ledger_change() {
  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let pool = harness.create("damaged").await?;
    pools.push(pool.clone());
    myoxus_infrastructure::migrations::run(&pool).await.unwrap();
    sqlx::query("DROP FUNCTION document_metadata_default_language_id()")
      .execute(&pool)
      .await?;
    let ledger = ledger_snapshot(&pool).await;
    let error = myoxus_infrastructure::migrations::run(&pool)
      .await
      .expect_err("a damaged current schema must fail final invariants");
    let message = error.to_string();
    assert!(message.contains("class=baseline"), "{message}");
    assert!(
      message.contains("invariant=canonical locale configuration"),
      "{message}"
    );
    assert_eq!(ledger_snapshot(&pool).await, ledger);
    Ok::<(), sqlx::Error>(())
  })
  .catch_unwind()
  .await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("clean damaged migration database");
  match result {
    Ok(result) => result.expect("verify damaged schema rejection"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}

#[tokio::test]
async fn audio_results_upgrade_preserves_existing_rows_models_and_legacy_payloads() {
  use futures_util::FutureExt;
  use myoxus_domain::transcription::{TranscriptionResultQuery, TranscriptionResultRepository};
  use myoxus_infrastructure::transcription::results::PgTranscriptionResultRepository;
  use serde_json::json;

  let mut harness = DatabaseHarness::new().await.expect("connect migration harness");
  let mut pools = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let pool = harness.create("audio_results").await?;
    pools.push(pool.clone());
    install_baseline_1000(&pool).await?;
    let user = Uuid::new_v4();
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Audio migration')")
      .bind(user).bind(format!("audio-migration-{user}@test.invalid")).execute(&pool).await?;
    sqlx::query("INSERT INTO workspaces (id) VALUES ($1)").bind(workspace).execute(&pool).await?;
    let legacy_job = Uuid::new_v4();
    let existing_job = Uuid::new_v4();
    let string_job = Uuid::new_v4();
    let legacy = json!({"blobId":"audio-first","transcription":{"text":"Heute planen wir den Test.","model":"model-a","segments":[]}});
    let conflict = json!({"blobId":"audio-second","transcriptionConfig":{"model":"model-a"},"transcription":{"text":"Old conflicting text","model":"model-a"}});
    let string_payload = json!({"blobId":"audio-string","model":"historical-string-model","transcription":"Vollständiger alter String."});
    for (id, payload) in [(legacy_job, &legacy), (existing_job, &conflict), (string_job, &string_payload)] {
      sqlx::query("INSERT INTO copilot_jobs (id, job_type, state, workspace_id, user_id, payload) VALUES ($1, 'audio_transcription', 'finished', $2, $3, $4)")
        .bind(id).bind(workspace).bind(user).bind(payload).execute(&pool).await?;
    }
    let existing_id = Uuid::new_v4();
    let other_model_id = Uuid::new_v4();
    let document_result_id = Uuid::new_v4();
    let metadata = json!({"title":"Historical title","summary":"Historical notes","action_items":"Historical action","custom":{"preserved":true}});
    let segments = json!([{"text":"Gespeicherter Text.","start":0.5,"end":1.5}]);
    sqlx::query("INSERT INTO copilot_transcripts (id, workspace_id, source_type, source_id, content, segments, model, metadata, status, updated_at) VALUES ($1, $2, 'audio', 'audio-second', 'Gespeicherter Text.', $3, 'model-a', $4, 'completed', '2026-01-01')")
      .bind(existing_id).bind(workspace).bind(&segments).bind(&metadata).execute(&pool).await?;
    sqlx::query("INSERT INTO copilot_transcripts (id, workspace_id, source_type, source_id, content, model, status, updated_at) VALUES ($1, $2, 'audio', 'audio-second', 'Different model result.', 'model-b', 'completed', '2026-02-01')")
      .bind(other_model_id).bind(workspace).execute(&pool).await?;
    sqlx::query("INSERT INTO copilot_transcripts (id,workspace_id,source_type,source_id,content,segments,model,metadata,status,updated_at) VALUES ($1,$2,'document','audio-second',$3,$4,'model-a',$5,'completed','2026-03-01')")
      .bind(document_result_id).bind(workspace).bind("# Besprechung\n\nUnveränderter Absatz.")
      .bind(json!([{ "text":"Dokumentsegment","speaker":"Stored speaker" }])).bind(json!({"document":{"retained":true}})).execute(&pool).await?;
    let document_before: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(t) FROM copilot_transcripts t WHERE id = $1")
      .bind(document_result_id).fetch_one(&pool).await?;

    // The production runner is the only executor of the new forward migration.
    myoxus_infrastructure::migrations::run(&pool).await.expect("upgrade audio results");
    assert_current_ledger(&pool).await;
    let document_after: serde_json::Value = sqlx::query_scalar("SELECT to_jsonb(t) FROM copilot_transcripts t WHERE id = $1")
      .bind(document_result_id).fetch_one(&pool).await?;
    assert_eq!(document_after,document_before,"audio migration must preserve the entire document result");
    let repository = PgTranscriptionResultRepository::new(pool.clone());
    let string_query = TranscriptionResultQuery { user_id:user, workspace_id:Some(workspace), job_id:Some(string_job), blob_id:Some("audio-string".into()) };
    let string_result = repository.query(&string_query).await.expect("legacy string readback");
    let stored_string = string_result[0].transcript.as_ref().expect("canonical string result");
    assert_eq!(stored_string.model,"historical-string-model");
    assert_eq!(stored_string.response.text,"Vollständiger alter String.");
    for (id, expected_text) in [(legacy_job, "Heute planen wir den Test."), (existing_job, "Gespeicherter Text.")] {
      let query = TranscriptionResultQuery { user_id:user, workspace_id:Some(workspace), job_id:Some(id), blob_id:None };
      let first = repository.query(&query).await.expect("upgraded readback");
      assert_eq!(first.len(),1);
      let stored = first[0].transcript.as_ref().expect("canonical migrated result");
      assert_eq!(stored.response.text,expected_text);
      assert_eq!(stored.model,"model-a");
      if id == existing_job {
        assert_eq!(stored.id,existing_id);
        assert_eq!(stored.response.segments.len(),1);
        assert_eq!(stored.response.segments[0].speaker,None);
        assert_eq!(stored.response.segments[0].start_seconds,Some(0.5));
        assert_eq!(stored.title.as_deref(),Some("Historical title"));
        assert_eq!(stored.summary.as_deref(),Some("Historical notes"));
      }
      let repeated = repository.query(&query).await.expect("repeatable readback");
      assert_eq!(repeated[0].transcript.as_ref().expect("retained result").id,stored.id);
    }
    let preserved: (serde_json::Value,serde_json::Value,String) = sqlx::query_as("SELECT j.payload, t.metadata, t.content FROM copilot_jobs j JOIN copilot_transcripts t ON t.id = j.transcription_result_id WHERE j.id = $1")
      .bind(existing_job).fetch_one(&pool).await?;
    assert_eq!(preserved,(conflict,metadata,"Gespeicherter Text.".into()));
    let other: String = sqlx::query_scalar("SELECT content FROM copilot_transcripts WHERE id = $1")
      .bind(other_model_id).fetch_one(&pool).await?;
    assert_eq!(other,"Different model result.");
    myoxus_infrastructure::migrations::run(&pool).await.expect("repeat normal runner");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM copilot_transcripts").fetch_one(&pool).await?;
    assert_eq!(count,5,"repeat startup must not duplicate results");
    Ok::<(),sqlx::Error>(())
  }).catch_unwind().await;
  let cleanup = harness.cleanup(pools).await;
  cleanup.expect("remove isolated audio migration database");
  match result {
    Ok(result) => result.expect("verify durable audio upgrade"),
    Err(panic) => std::panic::resume_unwind(panic),
  }
}
