//! Shared test helpers for myoxus-api integration tests.
//!
//! `integration.rs` exposes this file as the crate-root `helpers` module.
//! Integration test modules should import it with `use crate::helpers;`
//! instead of declaring their own local helper module.
//!
//! All functions are `pub` so each test binary can use them.

#![allow(dead_code)]

use std::{
  future::Future,
  path::Path,
  sync::{Arc, Mutex, OnceLock},
};

use async_trait::async_trait;

/// Global lock for tests that mutate `app_configs.template_registry.enabled`.
/// Hold this guard for the entire duration of any test that disables or reads
/// the template registry enabled flag, to prevent races with parallel tests.
pub static TEMPLATE_REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Global lock for cache_auto_tuning tests that share the `app_config` cache_name
/// in `cache_tuning_metrics`. Prevents oscillation-detection false-positives from
/// parallel inserts of "increased" and "decreased" records.
pub static CACHE_TUNING_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Global lock for tests that read or write `app_configs.client.download_url`.
/// Prevents the default-empty test from seeing a value written by the roundtrip test.
pub static DOWNLOAD_URL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Global lock for tests that read or write `app_configs.server.deployment_type`.
/// Prevents parallel tests from deleting/writing the row while another is asserting it.
pub static DEPLOYMENT_TYPE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Global lock for all git sync tests (across both graphql_git_sync_profile_test
/// and git_sync_e2e_test). Prevents concurrent mutations of `app_configs.git_sync.*`
/// from interfering with each other.
pub static GIT_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Global lock for tests that mutate `app_configs.auth.*`.
/// OAuth/OIDC callback tests evaluate these keys lazily during sign-in, so a
/// parallel config mutation would otherwise create non-deterministic policy
/// assertions.
pub static AUTH_CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Global async lock for tests that write to `server.name` or `server.origin`
/// in `app_configs`. Coordinates across `cache_graceful_degradation_test`,
/// `cache_server_config_test`, and `multi_instance_redis_failure_test`, which
/// all mutate the same shared DB keys and read them back in a write-then-verify
/// pattern — parallel writes stomp on each other.
pub static SERVER_CONFIG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Global async lock for the singleton `client.updateControl` policy row.
/// Query, listener and Socket.IO integration tests intentionally exercise the
/// real shared row, so they must own it from setup through cleanup.
pub static CLIENT_UPDATE_CONTROL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Global async lock for tests that mutate server-owned theme/branding tables.
/// The catalog itself is global, and changing the global branding profile while
/// another PDF/runtime-CSS test is resolving effective branding produces false
/// font/theme assertions.
pub static THEME_BRANDING_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Deterministic transport for API integration tests that exercise Git-Sync
/// profile lifecycle behavior. Remote validation remains part of the call;
/// only external network I/O is replaced at the composition boundary.
struct TestGitRepository;

#[async_trait]
impl myoxus_application::git_sync::GitRepositoryPort for TestGitRepository {
  async fn probe_remote(
    &self,
    _url: &str,
    branch: Option<&str>,
    _auth: &myoxus_application::git_sync::GitAuth,
  ) -> Result<myoxus_application::git_sync::GitRemoteProbe, myoxus_application::git_sync::GitError> {
    Ok(myoxus_application::git_sync::GitRemoteProbe {
      branch: branch.map(str::to_string),
      observed_remote_oid: Some("a".repeat(40)),
    })
  }

  async fn clone_repo(
    &self,
    _url: &str,
    _path: &Path,
    _branch: &str,
    _auth: &myoxus_application::git_sync::GitAuth,
  ) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not execute Git-Sync runs".to_string(),
    ))
  }

  async fn open_repo(&self, _path: &Path) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not open repositories".to_string(),
    ))
  }

  async fn fetch(
    &self,
    _auth: &myoxus_application::git_sync::GitAuth,
  ) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not fetch repositories".to_string(),
    ))
  }

  async fn checkout_branch(&self, _branch: &str) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not check out repositories".to_string(),
    ))
  }

  async fn reset_to_remote(&self, _branch: &str) -> Result<String, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not reset repositories".to_string(),
    ))
  }

  async fn head_oid(&self) -> Result<String, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn remote_branch_oid(
    &self,
    _branch: &str,
    _auth: &myoxus_application::git_sync::GitAuth,
  ) -> Result<String, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not inspect remote branches".to_string(),
    ))
  }

  async fn changed_files(
    &self,
    _from: Option<&str>,
    _to: Option<&str>,
  ) -> Result<Vec<myoxus_application::git_sync::ChangedFile>, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn read_file(&self, _path: &str) -> Result<Vec<u8>, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn delete_file(&self, _path: &str) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn rename_file(&self, _from: &str, _to: &str) -> Result<(), myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter has no working tree".to_string(),
    ))
  }

  async fn commit(
    &self,
    _message: &str,
    _author_name: &str,
    _author_email: &str,
  ) -> Result<String, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not commit".to_string(),
    ))
  }

  async fn push(
    &self,
    _branch: &str,
    _intended_oid: &str,
    _auth: &myoxus_application::git_sync::GitAuth,
  ) -> Result<myoxus_application::git_sync::backend::GitPushReceipt, myoxus_application::git_sync::GitError> {
    Err(myoxus_application::git_sync::GitError::Internal(
      "test probe adapter does not push".to_string(),
    ))
  }
}

struct TestGitRepositoryBuilder;

impl myoxus_api::git_sync_engine::GitRepositoryBuilder for TestGitRepositoryBuilder {
  fn build(
    &self,
    _pool: sqlx::PgPool,
    _policy: &myoxus_api::git_sync_engine::policy::EffectiveGitSyncPolicy,
    _source: &'static str,
    _actor_id: Option<uuid::Uuid>,
  ) -> Arc<dyn myoxus_application::git_sync::GitRepositoryPort> {
    Arc::new(TestGitRepository)
  }
}

/// Exercise the current Git-Sync import boundary used by the runner: prepare
/// every document before remote movement, then commit the imported documents
/// and terminal run state in the single post-push transaction.
pub async fn commit_git_sync_import(
  pool: &sqlx::PgPool,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
  actions: &[myoxus_application::git_sync::doc_reconcile_plan::SyncAction],
  git_files: &[(String, String)],
) -> Result<(), String> {
  use chrono::Utc;
  use myoxus_api::git_sync_engine::executor::prepare_myoxus_document_actions;
  use myoxus_application::git_sync::finalization::GitSyncPostPushPlan;
  use myoxus_domain::git_sync::{GitSyncRun, GitSyncRunSource, RunStatus};
  use myoxus_infrastructure::git_sync::SqlxGitSyncStore;
  use uuid::Uuid;

  let store = SqlxGitSyncStore::new(pool.clone());
  store
    .create_profile(profile)
    .await
    .map_err(|error| format!("create Git-Sync test profile: {error}"))?;
  let prepared = prepare_myoxus_document_actions(
    pool,
    actions,
    git_files,
    profile,
    "https://myoxus.test",
    &[],
    &std::collections::HashMap::new(),
    &[],
    &std::collections::HashMap::new(),
    &std::collections::HashMap::new(),
  )
  .await?;
  let run_id = Uuid::new_v4();
  let job_id = format!("git-sync-test-{run_id}");
  let mut run = GitSyncRun {
    id: run_id,
    profile_id: profile.id,
    direction: profile.sync_direction,
    trigger_source: GitSyncRunSource::Manual,
    scheduled_for: None,
    status: RunStatus::Running,
    started_at: Utc::now(),
    finished_at: None,
    commit_before: None,
    commit_after: None,
    observed_remote_oid: Some("a".repeat(40)),
    reconciliation_required: false,
    reconciliation_reason: None,
    docs_created: prepared.upserts.len() as i32,
    docs_updated: 0,
    docs_deleted: prepared.deletes.len() as i32,
    conflicts_found: 0,
    error_message: None,
    error_class: None,
    job_id: Some(job_id.clone()),
  };
  store
    .create_run(&run)
    .await
    .map_err(|error| format!("create Git-Sync test run: {error}"))?;
  run
    .complete(Some("a".repeat(40)))
    .map_err(|error| format!("complete Git-Sync test run: {error}"))?;
  store
    .commit_post_push(&GitSyncPostPushPlan {
      run,
      workspace_id: profile.workspace_id,
      expected_job_id: job_id,
      document_upserts: prepared.upserts,
      document_deletes: prepared.deletes,
      document_bindings: vec![],
      document_tombstone_ids: vec![],
      document_baselines: vec![],
      document_conflicts: vec![],
      file_bindings: vec![],
      file_tombstone_paths: vec![],
      file_baselines: vec![],
      file_baseline_deletes: vec![],
      file_conflicts: vec![],
      version_links: vec![],
      blob_promotion_ids: vec![],
      partial: None,
    })
    .await
    .map_err(|error| format!("commit Git-Sync import: {error}"))?;
  Ok(())
}

/// Run a large async integration-test body on an explicit stack.
///
/// Some GraphQL integration tests build the full Axum application plus large
/// serde_json request literals in one test body. On the default libtest stack
/// this can overflow before the invariant is actually tested. Keeping the
/// stack bump local to those tests is less invasive than changing every
/// developer's shell environment via `RUST_MIN_STACK`.
pub fn block_on_large_stack<F, Fut>(name: &str, f: F)
where
  F: FnOnce() -> Fut + Send + 'static,
  Fut: Future<Output = ()> + 'static,
{
  std::thread::Builder::new()
    .name(name.to_string())
    .stack_size(16 * 1024 * 1024)
    .spawn(move || {
      tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(f());
    })
    .expect("spawn large-stack integration test thread")
    .join()
    .expect("large-stack integration test thread panicked");
}

/// Large-stack wrapper for tests that must exercise code paths using
/// `tokio::task::spawn_blocking` or `block_in_place`. The current-thread
/// wrapper above is intentionally cheaper, but the PDF sync-render pipeline
/// requires a multi-thread runtime.
pub fn block_on_large_stack_multithread<F, Fut>(name: &str, worker_threads: usize, f: F)
where
  F: FnOnce() -> Fut + Send + 'static,
  Fut: Future<Output = ()> + 'static,
{
  std::thread::Builder::new()
    .name(name.to_string())
    .stack_size(16 * 1024 * 1024)
    .spawn(move || {
      tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("tokio multi-thread runtime")
        .block_on(f());
    })
    .expect("spawn large-stack multi-thread integration test thread")
    .join()
    .expect("large-stack multi-thread integration test thread panicked");
}

use axum::{body::Body, http::Request};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use myoxus_api::{
  build_router_for_integration_tests, build_router_for_websocket_integration_tests,
  config::AppConfig,
  state::ApiState,
  websocket::{SocketDatabaseBroadcast, redis_adapter::RedisWsAdapter},
};
use myoxus_application::admin::AdminService;
use myoxus_application::api_key::ApiKeyService;
use myoxus_application::auth::{AuthService, AuthStore, NewSession};
use myoxus_application::calendar::{CalendarService, NativeEventService};
use myoxus_application::database::{DatabaseLimits, DatabaseServices};
use myoxus_application::doc::DocService;
use myoxus_application::document_graph::{DocumentGraphLimits, DocumentGraphService};
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::template_registry::TemplateRegistryService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace_automation::{WorkspaceAutomationLimits, WorkspaceAutomationService};
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::api_key::SqlxApiKeyStore;
use myoxus_infrastructure::audit::PgAuditLogStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::database_activity::PgDatabaseActivityStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_graph::PgDocumentGraphRepository;
use myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_infrastructure::document_version::{PgDocumentVersionRepository, PgDocumentVersioningSettingsRepository};
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::organization::{
  PgOrganizationPolicyRepository, PgOrganizationProjectRequestRepository, PgOrganizationRepository,
  PgOrganizationUnitLifecycleRepository, PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository,
  PgOrganizationUnitTypeRepository, PgOrganizationUnitWorkspaceRepository,
};
use myoxus_infrastructure::outbox::SqlxOutboxEventPublisher;
use myoxus_infrastructure::pdf_export::{
  PdfBlobStore, PgPdfExportRenderAuditRepository, PgPdfFontRepository, PgPdfIccProfileRepository,
  PgPdfTemplateRepository, PgPdfWorkspaceBrandAssetRepository, PgPdfWorkspaceTemplateAssignmentRepository,
  seed_system_pdf_templates,
};
use myoxus_infrastructure::redis::RedisAdapter;
use myoxus_infrastructure::search::SqlxSearchRepository;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_automation::PgWorkspaceAutomationRepository;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository;
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

fn database_limits(config: &AppConfig) -> DatabaseLimits {
  DatabaseLimits {
    max_fields_per_database: config.databases.max_fields_per_database,
    max_views_per_database: config.databases.max_views_per_database,
    default_rows_per_page: config.databases.default_rows_per_page,
    max_rows_per_page: config.databases.max_rows_per_page,
    max_cell_text_bytes: config.databases.max_cell_text_bytes,
    csv_max_bytes: config.databases.csv_max_bytes,
    csv_max_rows: config.databases.csv_max_rows,
    csv_max_columns: config.databases.csv_max_columns,
    csv_sample_rows_for_type_inference: config.databases.csv_sample_rows_for_type_inference,
    // P-DB-29: surfaced by DatabasesConfig (api/config.rs). The integration
    // helper used to omit this and the P-DB-25 tests stopped compiling once
    // DatabaseLimits grew the field; forward the configured value verbatim.
    notion_max_bytes: config.databases.notion_max_bytes,
    max_reminders_per_user_per_cell: config.databases.max_reminders_per_user_per_cell,
    max_reminder_offset_minutes: config.databases.max_reminder_offset_minutes,
    ..DatabaseLimits::default()
  }
}

fn wire_database_services(
  state: ApiState,
  pool: &PgPool,
  change_notifications: Option<Arc<dyn myoxus_application::ports::database_change::DatabaseChangeNotificationPort>>,
  template_registry: Option<TemplateRegistryService>,
) -> ApiState {
  let repo = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_service = state.doc().clone();
  let permission_service = state.permission_service();
  let workspace_tag_repo: Arc<dyn myoxus_domain::workspace_tags::WorkspaceTagRepository> = Arc::new(
    PgWorkspaceTagRepository::new(pool.clone(), crate::helpers::database_starter_catalog()),
  );
  let change_notifications = change_notifications
    .unwrap_or_else(|| Arc::new(myoxus_application::ports::database_change::NullDatabaseChangeNotification));
  let workspace_tag_service = Arc::new(
    myoxus_application::workspace_tags::WorkspaceTagService::new(workspace_tag_repo, permission_service.clone())
      .with_post_commit_effects(doc_service.doc_cache().cloned(), change_notifications.clone()),
  );
  let limits = database_limits(&state.config);
  let activity_store: Arc<dyn myoxus_domain::database_activity::DatabaseActivityStore> =
    Arc::new(PgDatabaseActivityStore::new(pool.clone()));
  let activity_recorder = myoxus_application::database::activity::DatabaseActivityRecorder::new(activity_store);
  let effects = myoxus_application::database::DatabaseMutationEffects::new(
    activity_recorder.clone(),
    Arc::new(state.audit_recorder().clone()),
    state.notification_service(),
    change_notifications,
  );
  let mut dependencies = myoxus_application::database::DatabaseServiceDependencies::disabled()
    .with_effects(effects)
    .with_blob_service(state.blob_service())
    .with_workspace_tags(workspace_tag_service.clone());
  if let Some(template_registry) = template_registry {
    dependencies = dependencies.with_template_registry(template_registry);
  }
  let database_services = Arc::new(DatabaseServices::new(
    repo.clone(),
    doc_service,
    permission_service,
    limits.clone(),
    Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    )),
    crate::helpers::database_starter_catalog(),
    dependencies,
  ));
  let feature_sources = feature_source_set();
  let packages = feature_sources.resolved.assistants.clone();
  let mut assistants = myoxus_application::workspace::assistant_packages::AssistantPackageService::new(
    Arc::new(packages),
    database_starter_catalog(),
    database_services.definition.clone(),
    database_services.views.clone(),
    Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
      pool.clone(),
      database_starter_catalog(),
    )),
    state.config.i18n.default_currency.clone(),
    state.config.i18n.default_locale.clone(),
  )
  .with_context_workflows_enabled(state.config.workspace_automation.enabled);
  if let Some(documents) = state.document_template_service() {
    assistants = assistants.with_project_placement(documents.clone());
    if let Some(registry) = state.template_registry() {
      assistants = assistants.with_document_components(documents, Arc::new(registry.clone()));
    }
  }
  let assistants = Arc::new(assistants);
  let automation_repo: Arc<dyn myoxus_domain::repositories::WorkspaceAutomationRepository> =
    Arc::new(PgWorkspaceAutomationRepository::new(pool.clone()));
  let automation_service = WorkspaceAutomationService::new(
    automation_repo,
    repo.clone(),
    repo.clone(),
    state.doc().clone(),
    state.permission_service(),
    state.audit_recorder().clone(),
    None,
    None,
    WorkspaceAutomationLimits {
      enabled: state.config.workspace_automation.enabled,
      max_actions_per_run: state.config.workspace_automation.max_actions_per_run,
      max_runs_per_minute: state.config.workspace_automation.max_runs_per_minute,
      webhook_timeout_seconds: state.config.workspace_automation.webhook_timeout_seconds,
      max_retry_attempts: state.config.workspace_automation.max_retry_attempts,
    },
    database_services.editing.clone(),
  )
  .with_context_documents(
    Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
      pool.clone(),
      database_starter_catalog(),
    )),
    assistants.clone(),
    Arc::new(state.auth().clone()),
  );
  let runtime = Arc::new(
    myoxus_infrastructure::workflow_runtime::GlirulusWorkspaceAutomationRuntime::new(
      pool.clone(),
      automation_service.native_executor(),
    ),
  );
  let automation_service = Arc::new(automation_service.with_runtime(runtime));
  let task_recurrence = Arc::new(myoxus_application::recurrence::TaskRecurrenceService::new(
    Arc::new(myoxus_infrastructure::recurrence::PgTaskRecurrenceRepository::new(
      pool.clone(),
      repo.clone(),
    )),
    database_services.editing.clone(),
  ));
  state
    .with_feature_sources(feature_sources)
    .with_assistant_packages(assistants)
    .with_database_services(database_services)
    .with_task_recurrence_service(task_recurrence)
    .with_workspace_tag_service(workspace_tag_service)
    .with_workspace_automation_service(automation_service)
    .with_database_activity_recorder(activity_recorder)
}

// ---------------------------------------------------------------------------
// Database and application bootstrap
// ---------------------------------------------------------------------------

/// Connect to the test database, run migrations, and return the pool.
pub async fn setup_pool() -> PgPool {
  setup_pool_with_max_connections(2).await
}

async fn setup_pool_with_max_connections(max_connections: u32) -> PgPool {
  // In-process fixtures bypass server main, including its TLS bootstrap.
  myoxus_infrastructure::tls::initialize_crypto_provider();
  // Default to the isolated test stack (:5434) — NEVER the dev DB (:5432).
  // Tests that accidentally run without TEST_DATABASE_URL must not pollute
  // the production database (P22-A/B, user-reported multiple times).
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPoolOptions::new()
    .max_connections(max_connections)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("test DB connection failed");
  // Compile the complete migration set, including persisted config-path
  // canonicalization, into every isolated integration-test database.
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
  let _theme_seed_guard = THEME_BRANDING_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  myoxus_infrastructure::branding::seed_system_theme_branding(&pool)
    .await
    .expect("theme branding seed");
  myoxus_infrastructure::document_metadata::sync_document_default_language_from_locale(
    &pool,
    "en",
    &myoxus_api::config::AppConfigStartupValidator,
  )
  .await
  .expect("document metadata default language sync");
  pool
}

/// Compose the same persisted comment and document-ACL services for GraphQL and MCP.
pub(crate) async fn setup_comment_app(mcp: bool) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  use myoxus_api::build_router_for_integration_tests as build_router;
  use myoxus_application::comment::{AuthStoreCommentAdapter, CommentService};
  use myoxus_application::notification::NotificationService;
  use myoxus_infrastructure::comment::SqlxCommentRepository;
  use myoxus_infrastructure::notification::SqlxNotificationRepository;

  let pool = setup_pool().await;
  let mut config = AppConfig::load().expect("AppConfig must load");
  config.mcp.enabled = mcp;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(
    blob_store,
    storage.clone(),
    "test-sign-key".to_string(),
  ));
  let mailer = Arc::new(LogMailAdapter);

  let auth_service = AuthService::new(auth_store.clone(), mailer, storage.clone(), 3600, 3600);

  let notification_repo = Arc::new(SqlxNotificationRepository::new(pool.clone()));
  let notification_service = Arc::new(NotificationService::new(notification_repo));
  let comment_repo = Arc::new(SqlxCommentRepository::new(pool.clone()));
  let permission = Arc::new(myoxus_application::permission::PermissionService::new(
    auth_store.clone(),
  ));
  let auth_adapter = Arc::new(AuthStoreCommentAdapter::new_with_permission_service(
    auth_store.clone(),
    permission.clone(),
  ));
  let comment_service = Arc::new(CommentService::new_with_mentions(
    comment_repo,
    auth_adapter.clone(),
    auth_adapter,
  ));

  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);

  let state = ApiState::with_services_comment_and_permission(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    comment_service,
    notification_service,
    blob_service,
    storage,
    permission,
  )
  .with_metrics_pool(pool.clone())
  .with_html_catalog(Arc::new(
    myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html"),
    ),
  ));

  let router = if mcp {
    let state = state
      .with_audit_recorder(myoxus_application::audit::AuditRecorder::new(Arc::new(
        myoxus_infrastructure::audit::PgAuditLogStore::new(pool.clone()),
      )))
      .with_api_key_service(myoxus_application::api_key::ApiKeyService::new(Arc::new(
        myoxus_infrastructure::api_key::SqlxApiKeyStore::new(pool.clone()),
      )))
      .with_document_metadata_service(myoxus_application::document_metadata::DocumentMetadataService::new(
        Arc::new(myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository::new(pool.clone())),
      ))
      .with_document_metadata_policy_repo(Arc::new(
        myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository::new(pool.clone()),
      ))
      .with_document_version_repo(Arc::new(
        myoxus_infrastructure::document_version::PgDocumentVersionRepository::new(pool.clone()),
      ));
    myoxus_api::build_router_for_mcp_integration_tests(state)
  } else {
    build_router(state)
  };
  (router, pool, auth_store)
}

/// Full application stack: router, pool, and the raw auth store (for session
/// creation in tests). The auth store is returned separately so callers can
/// use `create_session`.
pub async fn setup_app() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  setup_app_with_pool(pool).await
}

/// Ordinary router fixture retaining its real service snapshot for immutable
/// source-set replacement tests; all optional runtime integrations stay disabled.
pub async fn setup_app_with_state() -> (axum::Router, PgPool, Arc<SqlxAuthStore>, ApiState) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services_state(pool, |_| {}, false, false, false, false, None, None, None, None).await
}

/// Retain the existing SQL-backed state with an explicit startup configuration,
/// allowing consuming tests to install the normal provider adapter before routing.
pub async fn setup_app_with_config_override_and_state<F>(
  config_override: F,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>, ApiState)
where
  F: FnOnce(&mut AppConfig),
{
  let pool = setup_pool().await;
  build_test_app_with_config_and_services_state(
    pool,
    config_override,
    false,
    false,
    false,
    false,
    None,
    None,
    None,
    None,
  )
  .await
}

/// Same as `setup_app` but reuses an existing pool.
pub async fn setup_app_with_pool(pool: PgPool) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  build_test_app(pool).await
}

/// Same as [`setup_app`], but keeps the Socket.IO handle in `ApiState`.
///
/// Most integration tests must use [`setup_app`] so each router's PgPool drops
/// when the test ends. Socket.IO broadcast tests need the handle because the
/// websocket handlers emit through the server instance stored in state.
pub async fn setup_app_with_socket_io_handle() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  setup_app_with_socket_io_handle_and_pool(pool).await
}

/// Retain Socket.IO on an owned database when a fixture exercises a global outbox claim.
pub async fn setup_app_with_socket_io_handle_and_pool(pool: PgPool) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  build_test_app_with_config_and_services(pool, |_| {}, false, false, false, true, None, None, None, None).await
}

/// Production-shaped Database Socket.IO app backed by the isolated test Redis.
///
/// This is deliberately opt-in: it retains the Socket.IO handle and wires the
/// same `SocketDatabaseBroadcast` port as the server binary, while ordinary
/// integration routers remain short-lived and Redis-free.
pub async fn setup_app_with_database_socket_runtime() -> (axum::Router, PgPool, Arc<SqlxAuthStore>, Arc<RedisWsAdapter>)
{
  let pool = setup_pool().await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let namespace = format!("pdb29b-socket-{}", Uuid::new_v4());
  let redis = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("Database Socket.IO test Redis adapter"));
  let websocket = Arc::new(RedisWsAdapter::new(Uuid::new_v4(), redis));
  let (router, pool, auth_store) = build_test_app_with_config_and_services(
    pool,
    |_| {},
    false,
    false,
    false,
    true,
    Some(websocket.clone()),
    None,
    None,
    None,
  )
  .await;
  (router, pool, auth_store, websocket)
}

/// Socket.IO test app whose admission adapter targets a caller-provided Redis
/// URL. This is intentionally narrow: fail-closed handshake tests need to
/// exercise the real middleware while making only admission unavailable.
pub async fn setup_app_with_socket_admission_redis_url(redis_url: &str) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  let namespace = format!("socket-admission-override-{}", Uuid::new_v4());
  let redis = Arc::new(RedisAdapter::new(redis_url, namespace).expect("Socket.IO admission test Redis URL"));
  let websocket = Arc::new(RedisWsAdapter::new(Uuid::new_v4(), redis));
  build_test_app_with_config_and_services(
    pool,
    |_| {},
    false,
    false,
    false,
    false,
    Some(websocket),
    None,
    None,
    None,
  )
  .await
}

/// Production-shaped GraphQL test app with an isolated Redis worker queue.
///
/// The queue is returned so the caller can inspect the dispatched job and
/// delete all waiting jobs through [`myoxus_worker::RedisQueue::empty_queue`].
pub async fn setup_app_with_git_sync_queue() -> (axum::Router, PgPool, Arc<SqlxAuthStore>, myoxus_worker::RedisQueue) {
  setup_app_with_worker_queue(format!("git-sync-test-{}", Uuid::new_v4().as_simple())).await
}

/// Caller-owned namespace permits complete Redis cleanup after a queue journey.
pub async fn setup_app_with_worker_queue(
  namespace: String,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>, myoxus_worker::RedisQueue) {
  let pool = setup_pool().await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue = myoxus_worker::RedisQueue::new(&redis_url, namespace).expect("isolated test worker queue");
  let (router, pool, auth_store) = build_test_app_with_config_and_services(
    pool,
    |_| {},
    false,
    false,
    false,
    false,
    None,
    Some(queue.clone()),
    Some(Arc::new(TestGitRepositoryBuilder)),
    None,
  )
  .await;
  (router, pool, auth_store, queue)
}

/// GraphQL test app with only the external Git profile probe replaced.
pub async fn setup_app_with_git_sync_repository() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(
    pool,
    |_| {},
    false,
    false,
    false,
    false,
    None,
    None,
    Some(Arc::new(TestGitRepositoryBuilder)),
    None,
  )
  .await
}

/// Same as `setup_app_with_pool`, but with a targeted `AppConfig` mutation.
pub async fn setup_app_with_pool_and_config_override<F>(
  pool: PgPool,
  config_override: F,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>)
where
  F: FnOnce(&mut AppConfig),
{
  build_test_app_with_config(pool, config_override).await
}

/// Same production-like test app as `setup_app`, but with a targeted
/// `AppConfig` mutation before the Axum state is built. Use this for tests
/// where runtime behavior depends on startup config while still requiring the
/// real SQLx-backed repositories.
pub async fn setup_app_with_config_override<F>(config_override: F) -> (axum::Router, PgPool, Arc<SqlxAuthStore>)
where
  F: FnOnce(&mut AppConfig),
{
  let pool = setup_pool().await;
  setup_app_with_pool_and_config_override(pool, config_override).await
}

/// Production-shaped test app with the optional Copilot capability enabled.
///
/// Copilot contract tests must opt in explicitly instead of inheriting an
/// operator's local configuration or weakening the disabled-by-default gate.
pub async fn setup_app_with_copilot_enabled() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  setup_app_with_config_override(|config| {
    config.copilot.enabled = true;
  })
  .await
}

/// Same as `setup_app` but the returned state has a metrics pool, useful for
/// queue/worker endpoint tests.
pub async fn setup_app_with_metrics() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  setup_app().await
}

/// Full app plus PDF-export admin repositories.
///
/// Most generic integration tests deliberately keep PDF repos optional, but
/// AdminRoot contract tests need a production-like PDF surface so list queries
/// exercise the resolver path instead of stopping at "repository missing".
pub async fn setup_app_with_pdf_admin_repos() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(pool, |_| {}, true, false, false, false, None, None, None, None).await
}

/// Full app plus the Template Registry service.
///
/// Use this for AdminRoot tests that exercise template-registry mutations
/// through GraphQL. The default generic app keeps this service absent so tests
/// still catch accidental resolver dependencies.
pub async fn setup_app_with_template_registry_service() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(pool, |_| {}, false, true, false, false, None, None, None, None).await
}

/// Template/assignment consumers opt into SQL Inbox persistence explicitly.
/// Ordinary integration apps retain their existing in-memory notification and
/// comment stores, while this router and its DatabaseEffects share one service.
pub async fn setup_app_with_template_registry_and_sql_notifications() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  // The causal assignment race owns two writers, a Row barrier and an observer.
  let pool = setup_pool_with_max_connections(4).await;
  let notifications = Arc::new(myoxus_application::notification::NotificationService::new(Arc::new(
    myoxus_infrastructure::notification::SqlxNotificationRepository::new(pool.clone()),
  )));
  build_test_app_with_config_and_services(
    pool,
    |_| {},
    false,
    true,
    false,
    false,
    None,
    None,
    None,
    Some(notifications),
  )
  .await
}

/// Opt-in durable-notification consumer fixture, sharing the actual router state.
pub async fn setup_app_with_template_registry_and_sql_notifications_state()
-> (axum::Router, PgPool, Arc<SqlxAuthStore>, ApiState) {
  let pool = setup_pool_with_max_connections(4).await;
  let notifications = Arc::new(myoxus_application::notification::NotificationService::new(Arc::new(
    myoxus_infrastructure::notification::SqlxNotificationRepository::new(pool.clone()),
  )));
  build_test_app_with_config_and_services_state(
    pool,
    |_| {},
    false,
    true,
    false,
    false,
    None,
    None,
    None,
    Some(notifications),
  )
  .await
}

/// Durable Task consumer with the real SQL store and an owned mail capture port.
pub async fn setup_app_with_task_notification_mail(
  mail: Arc<dyn myoxus_application::ports::MailPort>,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>, ApiState) {
  let pool = setup_pool_with_max_connections(4).await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let repository = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let projector = myoxus_application::notification::mail::NotificationMailProjector::new(auth.clone())
    .with_services(
      WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
        pool.clone(),
        crate::helpers::database_starter_catalog(),
      ))),
      DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))),
      Arc::new(PermissionService::new(auth)),
    )
    .with_database_repository(repository.clone(), repository);
  let notifications = Arc::new(myoxus_application::notification::NotificationService::new_with_email(
    Arc::new(myoxus_infrastructure::notification::SqlxNotificationRepository::new(
      pool.clone(),
    )),
    mail,
    projector,
    true,
  ));
  build_test_app_with_config_and_services_state(
    pool,
    |_| {},
    false,
    true,
    false,
    false,
    None,
    None,
    None,
    Some(notifications),
  )
  .await
}

/// Full app plus Template Registry and the real Search repository.
///
/// P8 cross-flow tests need Search, Database, Document Graph and
/// Templates in one Axum state. Keep this as an explicit opt-in so older
/// tests still reveal accidental Search resolver dependencies.
pub async fn setup_app_with_template_registry_and_search_service() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(pool, |_| {}, false, true, true, false, None, None, None, None).await
}

/// Build the standard integration router with the canonical search repository.
///
/// Most API tests intentionally omit optional capabilities. Tests that assert
/// search-backed projections must opt in explicitly so a missing repository
/// cannot silently turn a product contract into a `null` response.
pub async fn setup_app_with_search_repository() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(pool, |_| {}, false, false, true, false, None, None, None, None).await
}

/// Build a test app with the PDF-export sync-render threshold set to
/// `threshold` blocks. Used by P6 tests that exercise the inline rendering
/// path (`PDFEXP-10` / `PDFEXP-11`).
///
/// Setting `threshold = 0` keeps the async export policy while still wiring the
/// production PDF template/admin repositories. Positive `exportPdf` API tests
/// need that production-like repository surface because `templateId: "default"`
/// is resolved before the queued job row is created.
pub async fn setup_app_with_pdf_sync_threshold(threshold: u32) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  setup_app_with_pdf_config(move |c| c.pdf_export.sync_threshold_blocks = threshold).await
}

/// Same production PDF wiring with caller-owned validator/dispatch configuration.
pub async fn setup_app_with_pdf_config<F>(config_override: F) -> (axum::Router, PgPool, Arc<SqlxAuthStore>)
where
  F: FnOnce(&mut AppConfig),
{
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(pool, config_override, true, false, false, false, None, None, None, None)
    .await
}

/// Production PDF and MCP adapters with an isolated existing Redis queue.
pub async fn setup_app_with_pdf_queue(
  threshold: u32,
  queue: myoxus_worker::RedisQueue,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  build_test_app_with_config_and_services(
    pool,
    move |config| {
      config.pdf_export.sync_threshold_blocks = threshold;
    },
    true,
    false,
    false,
    false,
    None,
    Some(queue),
    None,
    None,
  )
  .await
}

pub async fn setup_app_with_git_sync_webhook_secret(secret: &str) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  setup_app_with_git_sync_webhook_policy(secret, true).await
}

pub async fn setup_app_with_git_sync_webhook_policy(
  secret: &str,
  enabled: bool,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  clear_git_sync_policy_overrides(&pool).await;
  let secret = secret.to_string();
  build_test_app_with_config(pool, move |c| {
    c.git_sync.enabled = enabled;
    c.git_sync.webhook_allowed = true;
    c.git_sync.webhook_secret = Some(secret);
  })
  .await
}

pub async fn setup_app_with_git_sync_webhook_and_queue(
  secret: &str,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>, myoxus_worker::RedisQueue) {
  let pool = setup_pool().await;
  clear_git_sync_policy_overrides(&pool).await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let queue = myoxus_worker::RedisQueue::new(
    &redis_url,
    format!("git-sync-webhook-test-{}", Uuid::new_v4().as_simple()),
  )
  .expect("Git-Sync webhook test Redis queue");
  let secret = secret.to_string();
  let (router, pool, auth_store) = build_test_app_with_config_and_services(
    pool,
    move |config| {
      config.git_sync.enabled = true;
      config.git_sync.webhook_allowed = true;
      config.git_sync.webhook_secret = Some(secret);
    },
    false,
    false,
    false,
    false,
    None,
    Some(queue.clone()),
    None,
    None,
  )
  .await;
  (router, pool, auth_store, queue)
}

async fn clear_git_sync_policy_overrides(pool: &PgPool) {
  sqlx::query("DELETE FROM app_configs WHERE id IN ('git_sync.enabled', 'git_sync.webhook_allowed')")
    .execute(pool)
    .await
    .expect("clear Git-Sync webhook policy overrides");
}

/// Central builder: constructs the full test application stack from a pool.
async fn build_test_app(pool: PgPool) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  build_test_app_with_config(pool, |_| {}).await
}

/// Like [`build_test_app`] but lets a caller mutate the loaded `AppConfig`
/// before the state is built. Used by tests that need a config tweak
/// (for example, a positive `pdf_export.sync_threshold_blocks` to exercise
/// the sync render path).
async fn build_test_app_with_config<F>(pool: PgPool, config_override: F) -> (axum::Router, PgPool, Arc<SqlxAuthStore>)
where
  F: FnOnce(&mut AppConfig),
{
  build_test_app_with_config_and_services(
    pool,
    config_override,
    false,
    false,
    false,
    false,
    None,
    None,
    None,
    None,
  )
  .await
}

#[expect(
  clippy::too_many_arguments,
  reason = "the shared fixture exposes independent optional service capabilities"
)]
async fn build_test_app_with_config_and_services<F>(
  pool: PgPool,
  config_override: F,
  wire_pdf_admin_repos: bool,
  wire_template_registry_service: bool,
  wire_search_repository: bool,
  retain_socket_io_handle: bool,
  database_socket_adapter: Option<Arc<RedisWsAdapter>>,
  worker_queue: Option<myoxus_worker::RedisQueue>,
  git_repository_builder: Option<Arc<dyn myoxus_api::git_sync_engine::GitRepositoryBuilder>>,
  notification_service: Option<Arc<myoxus_application::notification::NotificationService>>,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>)
where
  F: FnOnce(&mut AppConfig),
{
  let (router, pool, auth, _) = build_test_app_with_config_and_services_state(
    pool,
    config_override,
    wire_pdf_admin_repos,
    wire_template_registry_service,
    wire_search_repository,
    retain_socket_io_handle,
    database_socket_adapter,
    worker_queue,
    git_repository_builder,
    notification_service,
  )
  .await;
  (router, pool, auth)
}

#[expect(
  clippy::too_many_arguments,
  reason = "the shared fixture exposes independent optional service capabilities"
)]
async fn build_test_app_with_config_and_services_state<F>(
  pool: PgPool,
  config_override: F,
  wire_pdf_admin_repos: bool,
  wire_template_registry_service: bool,
  wire_search_repository: bool,
  retain_socket_io_handle: bool,
  database_socket_adapter: Option<Arc<RedisWsAdapter>>,
  worker_queue: Option<myoxus_worker::RedisQueue>,
  git_repository_builder: Option<Arc<dyn myoxus_api::git_sync_engine::GitRepositoryBuilder>>,
  notification_service: Option<Arc<myoxus_application::notification::NotificationService>>,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>, ApiState)
where
  F: FnOnce(&mut AppConfig),
{
  // Owned SQLx pools bypass setup_pool and the server binary's TLS bootstrap.
  myoxus_infrastructure::tls::initialize_crypto_provider();
  let mut config = AppConfig::load().expect("config");
  // Cargo runs API tests from the crate directory; the shipped catalog is
  // relative to the server launch directory. Explicit overrides below retain
  // their own paths, including persisted operator catalogs.
  if std::path::Path::new(&config.templates.root_dir).is_relative() {
    config.templates.root_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../..")
      .join(&config.templates.root_dir)
      .to_str()
      .expect("test catalog path must be UTF-8")
      .to_owned();
  }
  // Disable the sync render path so existing pdf_export tests keep their
  // queued-status contract. Tests that exercise the sync path override
  // sync_threshold_blocks via `config_override`.
  config.pdf_export.sync_threshold_blocks = 0;
  config_override(&mut config);
  let file_config = config.clone();
  let database_config = myoxus_infrastructure::app_config::load_validated_app_config_values(&pool)
    .await
    .expect("load validated test app configuration");
  config = config
    .with_database_overrides(&database_config)
    .expect("materialize test app configuration");
  // Integration consumers capture the merged startup catalog, as server main does.
  let html_catalog = Arc::new(myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
    std::path::Path::new(&config.templates.root_dir).join("html"),
  ));
  let mail_directory = std::path::Path::new(&config.templates.root_dir).join("mail");
  let mail_template_renderer = Arc::new(
    myoxus_infrastructure::mail::MailTemplateRenderer::new(
      mail_directory.to_str().expect("mail catalog path must be UTF-8"),
    )
    .expect("startup mail catalog"),
  );
  let config_overrides = Arc::new(tokio::sync::RwLock::new(
    myoxus_api::config_reload::ConfigOverrides::from_sources(&file_config, &database_config),
  ));
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let auth_service = AuthService::new_with_token_ttls(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
    config.server.magic_link_ttl_seconds,
    config.auth.password_reset_ttl_seconds,
  )
  .expect("test AppConfig must contain valid auth token TTLs")
  .with_password_policy_provider(Arc::new(myoxus_api::config_reload::RuntimePasswordPolicyProvider::new(
    config.auth.password_requirements.clone(),
    config_overrides.clone(),
  )));
  let event_publisher = Arc::new(SqlxOutboxEventPublisher::new(pool.clone()));
  let workspace_service = WorkspaceService::new_with_events(workspace_store.clone(), event_publisher);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let document_metadata_policy_service =
    myoxus_application::document_metadata_policy::DocumentMetadataPolicyService::new(
      document_metadata_policy_repo.clone(),
    );
  let document_metadata_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataRepository> =
    Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let document_metadata_service =
    myoxus_application::document_metadata::DocumentMetadataService::new(document_metadata_repo);
  let database_graph_repo = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let document_graph_service = Arc::new(DocumentGraphService::new(
    Arc::new(PgDocumentGraphRepository::new(pool.clone())),
    Arc::new(doc_service.clone()),
    Arc::new(PermissionService::new(auth_store.clone())),
    Arc::new(document_metadata_service.clone()),
    Some(database_graph_repo.clone()),
    Some(database_graph_repo),
    None,
    DocumentGraphLimits::default(),
  ));
  let calendar_repo = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let calendar_service = Arc::new(CalendarService::new(calendar_repo.clone()));
  let native_event_service = Arc::new(NativeEventService::new(calendar_repo, auth_store.clone()));
  let version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository> =
    Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository> =
    Arc::new(PgDocumentVersioningSettingsRepository::new(pool.clone()));
  let git_token_rotation_service = Arc::new(myoxus_application::git_sync::GitTokenRotationService::new(
    Arc::new(myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone())),
    Arc::new(myoxus_infrastructure::git_sync::GitSyncTokenCredentialCodec::new(
      config.crypto.private_key.clone(),
    )),
    vec![Arc::new(
      myoxus_infrastructure::git_sync::GitLabTokenRotationAdapter::new(
        std::time::Duration::from_secs(config.git_sync.network_timeout_secs),
        None,
      )
      .expect("test GitLab token rotation adapter"),
    )],
  ));

  // Organization repos + aggregate services (Paket D-T01..). Tests cover
  // the GraphQL surface end-to-end against the real DB so we always wire
  // the full set, not lazily per-test.
  let organization_repo: Arc<dyn myoxus_domain::repositories::OrganizationRepository> =
    Arc::new(PgOrganizationRepository::new(pool.clone()));
  let organization_unit_type_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository> =
    Arc::new(PgOrganizationUnitTypeRepository::new(pool.clone()));
  let organization_unit_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository> =
    Arc::new(PgOrganizationUnitRepository::new(pool.clone()));
  let organization_unit_member_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository> =
    Arc::new(PgOrganizationUnitMemberRepository::new(pool.clone()));
  let organization_unit_workspace_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository> =
    Arc::new(PgOrganizationUnitWorkspaceRepository::new(pool.clone()));
  let organization_policy_repo: Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository> =
    Arc::new(PgOrganizationPolicyRepository::new(pool.clone()));
  let organization_project_request_repo: Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository> =
    Arc::new(PgOrganizationProjectRequestRepository::new(pool.clone()));
  let organization_unit_lifecycle_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitLifecycleRepository> =
    Arc::new(PgOrganizationUnitLifecycleRepository::new(
      pool.clone(),
      serde_json::to_value(&config.oauth.providers).unwrap_or_else(|_| json!({})),
    ));
  let organization_unit_lifecycle_service =
    Arc::new(myoxus_application::organization::OrganizationUnitLifecycleService::new(
      organization_unit_lifecycle_repo,
      myoxus_application::audit::AuditRecorder::noop(),
    ));
  let (org_permission_service, org_project_request_service, org_import_export_service) =
    myoxus_api::organization::build_services(
      pool.clone(),
      organization_repo.clone(),
      organization_unit_type_repo.clone(),
      organization_unit_member_repo.clone(),
      organization_unit_repo.clone(),
      organization_unit_workspace_repo.clone(),
      organization_policy_repo.clone(),
      organization_project_request_repo.clone(),
    );

  let mut state = if let Some(notification_service) = notification_service {
    let auth_adapter = Arc::new(myoxus_application::comment::AuthStoreCommentAdapter::new(
      auth_store.clone(),
    ));
    let comment_service = Arc::new(myoxus_application::comment::CommentService::new_with_mentions(
      Arc::new(myoxus_application::comment::InMemoryCommentStore::default()),
      auth_adapter.clone(),
      auth_adapter,
    ));
    ApiState::with_services_and_comment(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      comment_service,
      notification_service,
      blob_service,
      storage.clone(),
    )
  } else {
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage.clone(),
    )
  }
  // Keep integration routers production-shaped: GraphQL key issuance, MCP
  // authentication and transport idempotency must all resolve the same
  // persisted API-key identity. An in-memory key here can authenticate while
  // violating the idempotency table's `api_keys(id)` foreign key.
  .with_api_key_service(ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone()))))
  .with_metrics_pool(pool.clone())
  .with_mail_template_renderer(mail_template_renderer)
  .with_html_catalog(html_catalog)
  .with_config_overrides_handle(config_overrides)
  .with_config_file_baseline(file_config)
  .with_document_metadata_policy_repo(document_metadata_policy_repo)
  .with_document_metadata_policy_service(document_metadata_policy_service)
  .with_document_metadata_service(document_metadata_service)
  .with_document_graph_service(document_graph_service)
  .with_calendar_service(calendar_service)
  .with_native_event_service(native_event_service)
  .with_document_version_repo(version_repo)
  .with_document_version_settings_repo(settings_repo)
  .with_git_token_rotation_service(git_token_rotation_service)
  .with_organization_template_context_service(Arc::new(
    myoxus_application::organization::OrganizationTemplateContextService::new(
      workspace_store.clone(),
      organization_repo.clone(),
      organization_unit_workspace_repo.clone(),
      organization_unit_repo.clone(),
    ),
  ))
  .with_organization_repo(organization_repo)
  .with_organization_unit_type_repo(organization_unit_type_repo)
  .with_organization_unit_repo(organization_unit_repo)
  .with_organization_unit_member_repo(organization_unit_member_repo)
  .with_organization_unit_workspace_repo(organization_unit_workspace_repo)
  .with_organization_policy_repo(organization_policy_repo)
  .with_organization_project_request_repo(organization_project_request_repo)
  .with_organization_permission_service(org_permission_service)
  .with_organization_project_request_service(org_project_request_service)
  .with_organization_import_export_service(org_import_export_service)
  .with_organization_unit_lifecycle_service(organization_unit_lifecycle_service);

  if let Some(builder) = git_repository_builder {
    state = state.with_git_sync_repository_builder(builder);
  }

  // Every Socket.IO integration router uses the production Redis admission
  // path. A unique namespace keeps parallel tests isolated; explicit adapters
  // are reserved for distributed-runtime and fail-closed tests.
  let wires_database_broadcast = database_socket_adapter.is_some();
  let websocket_adapter = match database_socket_adapter {
    Some(adapter) => adapter,
    None => {
      let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
      let namespace = format!("socket-test-{}", Uuid::new_v4());
      let redis = Arc::new(RedisAdapter::new(redis_url, namespace).expect("Socket.IO test Redis adapter"));
      Arc::new(RedisWsAdapter::new(Uuid::new_v4(), redis))
    }
  };
  state = state.with_redis_ws_adapter(websocket_adapter.clone());

  if wire_pdf_admin_repos {
    let pdf_blob_store = Arc::new(PdfBlobStore::new(storage.operator()));
    let pdf_template_repo = Arc::new(PgPdfTemplateRepository::new(pool.clone()));
    seed_system_pdf_templates(
      pdf_template_repo.clone(),
      pdf_blob_store.clone(),
      &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/pdf"),
      32 * 1024 * 1024,
      std::time::Duration::from_secs(120),
    )
    .await
    .expect("seed system PDF templates for PDF-export test app");
    myoxus_infrastructure::pdf_export::ensure_default_pdf_template_assignments(&pool)
      .await
      .expect("assign default PDF template for PDF-export test app");
    state = state
      .with_pdf_icc_repo(Arc::new(PgPdfIccProfileRepository::new(pool.clone())))
      .with_pdf_font_repo(Arc::new(PgPdfFontRepository::new(pool.clone())))
      .with_pdf_blob_store(pdf_blob_store)
      .with_pdf_template_repo(pdf_template_repo)
      .with_pdf_assignment_repo(Arc::new(PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone())))
      .with_pdf_brand_repo(Arc::new(PgPdfWorkspaceBrandAssetRepository::new(pool.clone())))
      .with_pdf_render_audit_repo(Arc::new(PgPdfExportRenderAuditRepository::new(pool.clone())));
  }

  let template_registry = if wire_template_registry_service {
    // Template-registry GraphQL tests need the canonical enabled state even
    // when another test previously wrote an override into the shared test DB.
    // Callers that use this branch should hold TEMPLATE_REGISTRY_LOCK.
    sqlx::query("DELETE FROM app_configs WHERE id = 'template_registry.enabled'")
      .execute(&pool)
      .await
      .ok();
    let template_service = TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(pool.clone())))
      .with_materialization(state.doc().clone(), state.storage().clone());
    state = state.with_template_registry_service(template_service.clone());
    Some(template_service)
  } else {
    None
  };

  let change_notifications = wires_database_broadcast.then(|| {
    Arc::new(SocketDatabaseBroadcast::new(Some(websocket_adapter)))
      as Arc<dyn myoxus_application::ports::database_change::DatabaseChangeNotificationPort>
  });
  state = wire_database_services(state, &pool, change_notifications, template_registry);

  if wire_search_repository {
    state = state.with_search_repository(Arc::new(SqlxSearchRepository::new(pool.clone())));
  }

  if let Some(queue) = worker_queue {
    state = state.with_redis_queue(queue);
  }

  // Use the production refresh owner so tests observe the same validation and
  // snapshot semantics after writing app_configs before setup.
  let _ = state.refresh_config_overrides().await;

  let captured_state = state.clone();
  let router = if wire_pdf_admin_repos && !retain_socket_io_handle {
    myoxus_api::build_router_for_mcp_integration_tests(state)
  } else if retain_socket_io_handle {
    build_router_for_websocket_integration_tests(state)
  } else {
    build_router_for_integration_tests(state)
  };
  (router, pool, auth_store, captured_state)
}

// ---------------------------------------------------------------------------
// User / session factories
// ---------------------------------------------------------------------------

/// Insert a user row and return its ID.
pub async fn create_user(pool: &PgPool, suffix: &str, is_admin: bool) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO users (id, email, name, is_admin, email_verified_at)
       VALUES ($1, $2, $3, $4, now())"#,
  )
  .bind(id)
  .bind(format!("{suffix}_{id}@example.test"))
  .bind(suffix)
  .bind(is_admin)
  .execute(pool)
  .await
  .expect("insert user");
  id
}

/// Create a session for a user and return the session ID.
pub async fn create_session(auth_store: &Arc<SqlxAuthStore>, user_id: Uuid) -> Uuid {
  auth_store
    .create_session(NewSession {
      id: Uuid::new_v4(),
      user_id,
      csrf_token: "test-csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: Utc::now() + Duration::hours(2),
      refresh_after: Utc::now() - Duration::minutes(5),
      created_at: Utc::now(),
    })
    .await
    .expect("create session")
    .id
}

/// Create a user + session in one step and return `(user_id, session_id)`.
pub async fn seed_user(pool: &PgPool, auth_store: &Arc<SqlxAuthStore>, suffix: &str) -> (Uuid, Uuid) {
  let user_id = create_user(pool, suffix, false).await;
  let session_id = create_session(auth_store, user_id).await;
  (user_id, session_id)
}

/// Create an admin user + session.
pub async fn seed_admin(pool: &PgPool, auth_store: &Arc<SqlxAuthStore>) -> (Uuid, Uuid) {
  let user_id = create_user(pool, "admin", true).await;
  let session_id = create_session(auth_store, user_id).await;
  (user_id, session_id)
}

/// Create a user with a specific display name (overrides the default
/// `create_user` behaviour which stores the suffix as the name) plus a
/// session. Returns `(user_id, session_id)`. Used by People/Users
/// import tests that need the `users.name` column to match a known
/// display name.
pub async fn seed_user_with_name(
  pool: &PgPool,
  auth_store: &Arc<SqlxAuthStore>,
  suffix: &str,
  display_name: &str,
) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO users (id, email, name, is_admin, email_verified_at)
       VALUES ($1, $2, $3, false, now())"#,
  )
  .bind(user_id)
  .bind(format!("{suffix}_{user_id}@example.test"))
  .bind(display_name)
  .execute(pool)
  .await
  .expect("insert user with name");
  let session_id = create_session(auth_store, user_id).await;
  (user_id, session_id)
}

/// Insert a row in `workspace_memberships` so the user is an accepted
/// member of the workspace. Used by People/Users import tests that
/// drive the `accepted_members_for_lookup` path.
pub async fn add_workspace_member(pool: &PgPool, workspace_id: Uuid, user_id: Uuid) {
  sqlx::query(
    r#"INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Collaborator', 'Accepted', now())
       ON CONFLICT (workspace_id, user_id) DO NOTHING"#,
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("insert accepted workspace member");
}

/// Create an admin user + session using only the DB pool (no router needed).
///
/// Useful for multi-instance tests where you need a session that is valid
/// across all router instances pointing at the same DB.  Returns
/// `(user_id, session_id)` — both usable with any router backed by `pool`.
pub async fn seed_admin_db(pool: &PgPool) -> (Uuid, Uuid) {
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let user_id = create_user(pool, "admin", true).await;
  let session_id = create_session(&auth_store, user_id).await;
  (user_id, session_id)
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

fn session_cookie(session_id: Uuid) -> String {
  format!("affine_session={session_id}")
}

/// POST a GraphQL request with an authenticated session.
pub async fn gql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", session_cookie(session_id))
        .body(Body::from(payload.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&body).expect("json")
}

/// POST an authenticated GraphQL request with additional headers.
pub async fn gql_with_headers(app: &axum::Router, session_id: Uuid, payload: Value, headers: &[(&str, &str)]) -> Value {
  let mut builder = Request::builder()
    .method("POST")
    .uri("/graphql")
    .header("content-type", "application/json")
    .header("cookie", session_cookie(session_id));
  for (name, value) in headers {
    builder = builder.header(*name, *value);
  }
  let resp = app
    .clone()
    .oneshot(builder.body(Body::from(payload.to_string())).expect("request"))
    .await
    .expect("response");
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&body).expect("json")
}

/// POST a GraphQL request without authentication.
pub async fn gql_anon(app: &axum::Router, payload: Value) -> Value {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&body).expect("json")
}

/// GET a URI with an authenticated session; returns parsed JSON.
pub async fn get_json(app: &axum::Router, session_id: Uuid, uri: &str) -> (u16, Value) {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(uri)
        .header("cookie", session_cookie(session_id))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  let status = resp.status().as_u16();
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
  (status, json)
}

/// GET a URI without authentication; returns `(status, body_bytes)`.
pub async fn get_raw(app: &axum::Router, uri: &str) -> (u16, bytes::Bytes) {
  let resp = app
    .clone()
    .oneshot(Request::builder().uri(uri).body(Body::empty()).expect("request"))
    .await
    .expect("response");
  let status = resp.status().as_u16();
  let body = resp.into_body().collect().await.expect("body").to_bytes();
  (status, body)
}

/// POST to a REST endpoint with JSON body and session cookie; returns `(status, json)`.
pub async fn post_json(app: &axum::Router, session_id: Uuid, uri: &str, body: Value) -> (u16, Value) {
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("cookie", session_cookie(session_id))
        .body(Body::from(body.to_string()))
        .expect("request"),
    )
    .await
    .expect("response");
  let status = resp.status().as_u16();
  let bytes = resp.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
  (status, json)
}

// ---------------------------------------------------------------------------
// Workspace / doc seed helpers
// ---------------------------------------------------------------------------

/// Insert a workspace owned by `owner_id` and return the workspace ID.
pub async fn create_workspace(pool: &PgPool, owner_id: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)
       VALUES ($1, $2, $3, FALSE, TRUE, TRUE, TRUE, TRUE)"#,
  )
  .bind(id)
  .bind(owner_id)
  .bind(format!("ws-{id}"))
  .execute(pool)
  .await
  .expect("insert workspace");

  sqlx::query(
    r#"INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Owner', 'Accepted', now())"#,
  )
  .bind(id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert membership");

  // Published workspace fixtures follow the same canonical Task infrastructure
  // as production; tests for interrupted provisioning create that state explicitly.
  let catalog = database_starter_catalog();
  let repository = Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
  myoxus_application::workspace::tasks::WorkspaceTasksInitializer::new(
    catalog,
    repository.clone(),
    std::sync::Arc::new(myoxus_application::database::DatabaseProjectionService::new(
      repository.clone(),
      repository.clone(),
      repository.clone(),
      repository.clone(),
      myoxus_application::database::DatabaseLimits::default(),
    )),
  )
  .ensure(id, Some(owner_id))
  .await
  .expect("initialize canonical Workspace Tasks fixture");
  id
}

/// Insert a doc and return its ID.
pub async fn create_doc(pool: &PgPool, workspace_id: Uuid, created_by: Uuid) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, $3, 'viewer', FALSE, $4, $4)"#,
  )
  .bind(id)
  .bind(workspace_id)
  .bind(format!("doc-{id}"))
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert doc");
  id
}

/// Insert the canonical workspace-root document used by document-owning flows.
pub async fn create_workspace_root_doc(pool: &PgPool, workspace_id: Uuid, created_by: Uuid) {
  sqlx::query(
    r#"INSERT INTO docs (id, external_id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by)
       VALUES ($1, $1::text, $1, 'Workspace root', 'owner', TRUE, $2, $2)"#,
  )
  .bind(workspace_id)
  .bind(created_by)
  .execute(pool)
  .await
  .expect("insert workspace root document");
}

// ---------------------------------------------------------------------------
// GraphQL query/mutation builders (small ergonomic wrappers)
// ---------------------------------------------------------------------------

/// Same as [`setup_app`] but wires a real [`PgAuditLogStore`] so that
/// mutations that emit audit events actually write to `admin_audit_log`.
///
/// Use this in tests that assert on `admin_audit_log` DB state.
pub async fn setup_app_with_audit() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  let (router, pool2, auth_store) = build_test_app(pool.clone()).await;
  // Rebuild — build_test_app uses noop recorder, we need real store.
  // Re-build from pool: the app router is recreated with audit wired in.
  let _ = (router, pool2); // discard noop build
  build_test_app_with_audit(pool, auth_store, false, None).await
}

/// User MCP lifecycle tests need persisted keys/receipts and real domain audit,
/// including the credential cascade on self-suspension.
pub async fn setup_app_with_mcp_and_audit() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  build_test_app_with_audit(pool, auth_store, true, None).await
}

/// Real SQLx MCP/audit composition with a caller-owned shared session cache.
/// Two API fixtures can exercise the same auth epoch namespace without mocking
/// transport authorization or persisted credentials. Email verification is
/// enabled here to exercise the guard that must apply after Admin demotion.
pub async fn setup_app_with_mcp_audit_and_session_cache(
  redis: Arc<dyn myoxus_application::ports::RedisPort>,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  let auth = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  build_test_app_with_audit(pool, auth, true, Some(redis)).await
}

/// Internal builder that wires the real [`PgAuditLogStore`] into the state.
async fn build_test_app_with_audit(
  pool: PgPool,
  reuse_auth_store: Arc<SqlxAuthStore>,
  production_mcp: bool,
  session_cache: Option<Arc<dyn myoxus_application::ports::RedisPort>>,
) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let mut config = AppConfig::load().expect("config");
  config.pdf_export.sync_threshold_blocks = 0;
  if session_cache.is_some() {
    config.auth.require_email_verification = true;
  }
  if production_mcp {
    config.mcp.enabled = true;
  }
  let auth_store = reuse_auth_store;
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));
  let mut auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  if let Some(redis) = session_cache {
    auth_service = auth_service.with_session_cache(redis, 300);
  }
  let event_publisher = Arc::new(SqlxOutboxEventPublisher::new(pool.clone()));
  let workspace_service = WorkspaceService::new_with_events(workspace_store.clone(), event_publisher);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let audit_store = Arc::new(PgAuditLogStore::new(pool.clone()));
  let audit_recorder = myoxus_application::audit::AuditRecorder::new(audit_store);
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let document_metadata_policy_service =
    myoxus_application::document_metadata_policy::DocumentMetadataPolicyService::new(
      document_metadata_policy_repo.clone(),
    );
  let document_metadata_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataRepository> =
    Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
  let document_metadata_service =
    myoxus_application::document_metadata::DocumentMetadataService::new(document_metadata_repo);
  let version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository> =
    Arc::new(PgDocumentVersionRepository::new(pool.clone()));
  let settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository> =
    Arc::new(PgDocumentVersioningSettingsRepository::new(pool.clone()));

  // Organization repos + services — same wiring as `build_test_app`. The
  // audit-aware setup needs them for ORG-G-06 manager audit assertions.
  let organization_repo: Arc<dyn myoxus_domain::repositories::OrganizationRepository> =
    Arc::new(PgOrganizationRepository::new(pool.clone()));
  let organization_unit_type_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository> =
    Arc::new(PgOrganizationUnitTypeRepository::new(pool.clone()));
  let organization_unit_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository> =
    Arc::new(PgOrganizationUnitRepository::new(pool.clone()));
  let organization_unit_member_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository> =
    Arc::new(PgOrganizationUnitMemberRepository::new(pool.clone()));
  let organization_unit_workspace_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository> =
    Arc::new(PgOrganizationUnitWorkspaceRepository::new(pool.clone()));
  let organization_policy_repo: Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository> =
    Arc::new(PgOrganizationPolicyRepository::new(pool.clone()));
  let organization_project_request_repo: Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository> =
    Arc::new(PgOrganizationProjectRequestRepository::new(pool.clone()));
  let organization_unit_lifecycle_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitLifecycleRepository> =
    Arc::new(PgOrganizationUnitLifecycleRepository::new(
      pool.clone(),
      serde_json::to_value(&config.oauth.providers).unwrap_or_else(|_| json!({})),
    ));
  let organization_unit_lifecycle_service =
    Arc::new(myoxus_application::organization::OrganizationUnitLifecycleService::new(
      organization_unit_lifecycle_repo,
      audit_recorder.clone(),
    ));
  let (org_permission_service, org_project_request_service, org_import_export_service) =
    myoxus_api::organization::build_services(
      pool.clone(),
      organization_repo.clone(),
      organization_unit_type_repo.clone(),
      organization_unit_member_repo.clone(),
      organization_unit_repo.clone(),
      organization_unit_workspace_repo.clone(),
      organization_policy_repo.clone(),
      organization_project_request_repo.clone(),
    );

  let mut state = wire_database_services(
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage,
    )
    .with_metrics_pool(pool.clone())
    .with_document_metadata_policy_repo(document_metadata_policy_repo)
    .with_document_metadata_policy_service(document_metadata_policy_service)
    .with_document_metadata_service(document_metadata_service)
    .with_document_version_repo(version_repo)
    .with_document_version_settings_repo(settings_repo)
    .with_organization_repo(organization_repo)
    .with_organization_unit_type_repo(organization_unit_type_repo)
    .with_organization_unit_repo(organization_unit_repo)
    .with_organization_unit_member_repo(organization_unit_member_repo)
    .with_organization_unit_workspace_repo(organization_unit_workspace_repo)
    .with_organization_policy_repo(organization_policy_repo)
    .with_organization_project_request_repo(organization_project_request_repo)
    .with_organization_permission_service(org_permission_service)
    .with_organization_project_request_service(org_project_request_service)
    .with_organization_import_export_service(org_import_export_service)
    .with_organization_unit_lifecycle_service(organization_unit_lifecycle_service)
    .with_audit_recorder(audit_recorder),
    &pool,
    None,
    None,
  );
  let _ = state.refresh_config_overrides().await;
  let router = if production_mcp {
    state = state.with_api_key_service(ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone()))));
    myoxus_api::build_router_for_mcp_integration_tests(state)
  } else {
    build_router_for_integration_tests(state)
  };
  (router, pool, auth_store)
}

/// Build a test app with `config.doc_service.endpoint` set to a custom value.
///
/// Used by proxy-delegation tests (F-01) to verify that requests are forwarded
/// to the remote doc service when an endpoint is configured.
pub async fn setup_app_with_doc_service_endpoint(endpoint: &str) -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  let pool = setup_pool().await;
  let mut config = AppConfig::load().expect("config");
  config.doc_service.endpoint = Some(endpoint.to_string());
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));
  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let state = wire_database_services(
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage,
    )
    .with_metrics_pool(pool.clone()),
    &pool,
    None,
    None,
  );
  (build_router_for_integration_tests(state), pool, auth_store)
}

/// Remove all DB rows created by a test.
///
/// Pass every user ID created during the test.  The function deletes:
/// 1. Workspace-scoped data (docs and memberships) for all workspaces owned by
///    these users.
/// 2. User-scoped data (sessions, memberships in other workspaces, etc.).
/// 3. The user rows themselves.
///
/// Errors are silently ignored so cleanup never masks test failures.
pub async fn cleanup_users(pool: &PgPool, user_ids: &[Uuid]) {
  if user_ids.is_empty() {
    return;
  }
  let workspace_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id = ANY($1)")
    .bind(user_ids)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

  if !workspace_ids.is_empty() {
    // Current Copilot contexts and sessions are independently workspace-bound;
    // their child tables cascade from these two roots.
    sqlx::query("DELETE FROM copilot_contexts WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM copilot_sessions WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM copilot_jobs WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    // Role tables use restrictive composite field/view foreign keys. Remove
    // them before workspace cascade deletes the referenced schema rows.
    sqlx::query("DELETE FROM database_field_roles WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = ANY($1))")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM database_view_roles WHERE database_id IN (SELECT id FROM workspace_databases WHERE workspace_id = ANY($1))")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    // Doc-level tables
    sqlx::query("DELETE FROM document_version WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query(
      "DELETE FROM document_versioning_settings WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = ANY($1))",
    )
    .bind(&workspace_ids)
    .execute(pool)
    .await
    .ok();
    sqlx::query("DELETE FROM doc_histories WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = ANY($1))")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    cleanup_document_outbox(pool, &workspace_ids).await;
    sqlx::query("DELETE FROM docs WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_doc_view_daily WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_member_last_access WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_invite_links WHERE workspace_id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
      .bind(&workspace_ids)
      .execute(pool)
      .await
      .ok();
  }

  // Null nullable FK references in docs that point to these users
  // (created_by, updated_by, userspace_owner_id may be NOT NULL in some rows)
  sqlx::query("UPDATE docs SET created_by = NULL WHERE created_by = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("UPDATE docs SET updated_by = NULL WHERE updated_by = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("UPDATE docs SET userspace_owner_id = NULL WHERE userspace_owner_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();

  // Organization domain — covers test artefacts created by the
  // `organization_*` GraphQL test suite (Paket D-T01..). Order matters:
  // children before parents.
  sqlx::query("DELETE FROM organization_unit_member WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM organization_project_request WHERE requested_by = ANY($1) OR decided_by = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();

  // Some journeys delete their workspace through the product before cleanup.
  // Recover only this fixture actor's orphan broadcasts, never active work.
  sqlx::query(
    "DELETE FROM outbox_events e WHERE e.event_type = 'workspace_doc_broadcast'
     AND e.payload->>'actorUserId' IN (SELECT unnest($1::uuid[])::text)
     AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id::text = e.payload->>'workspaceId')",
  )
  .bind(user_ids)
  .execute(pool)
  .await
  .expect("cleanup broadcasts from fixture workspaces already deleted by the product");

  // User-level rows (memberships in other workspaces, sessions, etc.)
  sqlx::query("DELETE FROM workspace_memberships WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM sessions WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM session_links WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM access_tokens WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM api_keys WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_features WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_preferences WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM verification_tokens WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .ok();
}

pub fn gql_query(query: &str) -> Value {
  json!({"query": query})
}

// ---------------------------------------------------------------------------
// Organization helpers (Paket D)
// ---------------------------------------------------------------------------

/// Look up the default organisation row from the canonical seed catalog.
/// Tests use this as the parent for OUs/policies they create.
pub async fn default_organization_id(pool: &PgPool) -> Uuid {
  sqlx::query_scalar("SELECT id FROM organization WHERE key = 'myoxus'")
    .fetch_one(pool)
    .await
    .expect("default organisation row")
}

/// Look up the first preset OU-type id (`team` is included in
/// the canonical baseline and is universally available).
pub async fn preset_unit_type_id(pool: &PgPool, key: &str) -> Uuid {
  sqlx::query_scalar("SELECT id FROM organization_unit_type WHERE key = $1")
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("preset unit type row")
}

/// Insert an OU row directly via SQL so tests can stage hierarchy state
/// without going through the GraphQL surface. Returns the new OU id.
pub async fn create_organization_unit(
  pool: &PgPool,
  organization_id: Uuid,
  unit_type_id: Uuid,
  parent: Option<Uuid>,
  name: &str,
) -> Uuid {
  let id = Uuid::new_v4();
  let slug = format!("{}-{}", name.to_lowercase().replace(' ', "-"), &id.to_string()[..8]);
  sqlx::query(
    r#"INSERT INTO organization_unit
         (id, organization_id, parent_unit_id, unit_type_id, name, slug, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb)"#,
  )
  .bind(id)
  .bind(organization_id)
  .bind(parent)
  .bind(unit_type_id)
  .bind(name)
  .bind(slug)
  .execute(pool)
  .await
  .expect("insert organization_unit");
  id
}

/// Assign a user as `manager` to an OU AND set the global `manager`
/// user-feature, so the two-axis check (`is_manager_for_unit`) returns
/// `true`.
pub async fn make_manager_of(pool: &PgPool, user_id: Uuid, unit_id: Uuid) {
  sqlx::query(
    r#"INSERT INTO user_features (user_id, feature_name, activated, created_at, updated_at)
       VALUES ($1, 'manager', true, now(), now())
       ON CONFLICT (user_id, feature_name) DO UPDATE SET activated = true, updated_at = now()"#,
  )
  .bind(user_id)
  .execute(pool)
  .await
  .expect("upsert user_features manager");
  sqlx::query(
    r#"INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata, created_at, updated_at)
       VALUES ($1, $2, 'manager', 'manual', '{}'::jsonb, now(), now())
       ON CONFLICT (unit_id, user_id) DO UPDATE SET role = 'manager', updated_at = now()"#,
  )
  .bind(unit_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("upsert org member");
}

/// Cleanup helper for tests that staged OUs directly. Removes OUs by id
/// (and their member rows / workspace links / project requests).
pub async fn cleanup_organization_units(pool: &PgPool, unit_ids: &[Uuid]) {
  if unit_ids.is_empty() {
    return;
  }
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id = ANY($1)")
    .bind(unit_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM organization_unit_workspace WHERE unit_id = ANY($1)")
    .bind(unit_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM organization_project_request WHERE parent_unit_id = ANY($1)")
    .bind(unit_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM organization_unit WHERE id = ANY($1)")
    .bind(unit_ids)
    .execute(pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

/// No-op blob-storage implementation for tests that do not need real object
/// storage.  Write/delete operations succeed silently; reads return `NotFound`;
/// multipart operations return `InvalidInput`.
#[derive(Default)]
pub struct DummyStorage;

#[async_trait::async_trait]
impl myoxus_application::ports::BlobStoragePort for DummyStorage {
  async fn write_blob(
    &self,
    _req: myoxus_application::ports::BlobWriteRequest,
  ) -> myoxus_application::ports::PortResult<()> {
    Ok(())
  }
  async fn read_blob(
    &self,
    _key: &str,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::BlobReadResponse> {
    Err(myoxus_application::ports::PortError::NotFound("missing".to_string()))
  }
  async fn delete_blob(&self, _key: &str) -> myoxus_application::ports::PortResult<()> {
    Ok(())
  }
  async fn put_avatar(
    &self,
    key: &str,
    _data: bytes::Bytes,
    _content_type: &str,
  ) -> myoxus_application::ports::PortResult<String> {
    Ok(key.to_string())
  }
  async fn get_avatar(
    &self,
    _key: &str,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::BlobReadResponse> {
    Err(myoxus_application::ports::PortError::NotFound("missing".to_string()))
  }
  async fn delete_avatar(&self, _key: &str) -> myoxus_application::ports::PortResult<()> {
    Ok(())
  }
  async fn create_multipart_upload(
    &self,
    _req: myoxus_application::ports::MultipartCreateRequest,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::MultipartCreateResponse> {
    Err(myoxus_application::ports::PortError::InvalidInput(
      "DummyStorage does not support multipart uploads".to_string(),
    ))
  }
  async fn create_multipart_part_url(
    &self,
    _req: myoxus_application::ports::MultipartPartUrlRequest,
  ) -> myoxus_application::ports::PortResult<myoxus_application::ports::MultipartPartUrlResponse> {
    Err(myoxus_application::ports::PortError::InvalidInput(
      "DummyStorage does not support multipart uploads".to_string(),
    ))
  }
  async fn complete_multipart_upload(
    &self,
    _req: myoxus_application::ports::MultipartCompleteRequest,
  ) -> myoxus_application::ports::PortResult<()> {
    Err(myoxus_application::ports::PortError::InvalidInput(
      "DummyStorage does not support multipart uploads".to_string(),
    ))
  }
  async fn abort_multipart_upload(&self, _upload_id: uuid::Uuid) -> myoxus_application::ports::PortResult<()> {
    Err(myoxus_application::ports::PortError::InvalidInput(
      "DummyStorage does not support multipart uploads".to_string(),
    ))
  }
}

pub fn gql_query_vars(query: &str, variables: Value) -> Value {
  json!({"query": query, "variables": variables})
}

// ---------------------------------------------------------------------------
// Blob helpers (P83-I-02)
// ---------------------------------------------------------------------------

/// Upload a blob through the active GraphQL multipart `setBlob` contract and
/// return the server-confirmed key. The REST workspace blob route is read-only.
pub async fn upload_blob(
  app: &axum::Router,
  session_id: Uuid,
  workspace_id: Uuid,
  key: &str,
  mime: &str,
  content: &[u8],
) -> String {
  let boundary = format!("X-MYOXUS-{}", Uuid::new_v4());
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": { "workspaceId": workspace_id.to_string(), "blob": null }
  })
  .to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();
  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Disposition: form-data; name=\"0\"; filename=\"{key}\"\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
  body.extend_from_slice(content);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("build blob upload request"),
    )
    .await
    .expect("send blob upload request");
  let status = response.status();
  let bytes = response
    .into_body()
    .collect()
    .await
    .expect("collect blob upload response")
    .to_bytes();
  assert!(status.is_success(), "upload_blob failed with status {}", status);
  let payload: Value = serde_json::from_slice(&bytes).expect("GraphQL blob upload response");
  assert!(payload.get("errors").is_none(), "upload_blob GraphQL error: {payload}");
  payload["data"]["setBlob"].as_str().expect("setBlob key").to_string()
}

/// Check whether a blob record exists in the DB for the given workspace + key.
pub async fn verify_blob_exists(pool: &PgPool, workspace_id: Uuid, key: &str) -> bool {
  let count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM blob_metadata WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .bind(key)
  .fetch_one(pool)
  .await
  .unwrap_or(0);
  count > 0
}

// ---------------------------------------------------------------------------
// Calendar seed helpers (P83-I-04)
// ---------------------------------------------------------------------------

/// Insert a user + session (real DB) and a `calendar_accounts` row for that
/// user.  Returns `(user_id, session_id, account_id)`.
pub async fn seed_calendar_user(pool: &PgPool, auth_store: &Arc<SqlxAuthStore>, suffix: &str) -> (Uuid, Uuid, Uuid) {
  let user_id = create_user(pool, suffix, false).await;
  let session_id = create_session(auth_store, user_id).await;
  let account_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO calendar_accounts
       (id, user_id, provider, external_id, access_token, refresh_token, token_expires_at, sync_enabled, created_at, updated_at)
       VALUES ($1, $2, 'local', $3, 'tok', NULL, now() + INTERVAL '1 hour', TRUE, now(), now())"#,
  )
  .bind(account_id)
  .bind(user_id)
  .bind(format!("ext-{suffix}-{user_id}"))
  .execute(pool)
  .await
  .expect("insert calendar_account");
  (user_id, session_id, account_id)
}

/// Insert a calendar event for an account.  Returns the event ID.
pub async fn create_calendar_event(
  pool: &PgPool,
  account_id: Uuid,
  title: &str,
  start: chrono::DateTime<chrono::Utc>,
  end: chrono::DateTime<chrono::Utc>,
) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO calendar_events
       (id, account_id, external_id, title, description, start_at, end_at, all_day,
        location, url, etag, raw_data, synced_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, FALSE, NULL, NULL, NULL, '{}', now(), now(), now())"#,
  )
  .bind(id)
  .bind(account_id)
  .bind(format!("ext-evt-{id}"))
  .bind(title)
  .bind(start)
  .bind(end)
  .execute(pool)
  .await
  .expect("insert calendar_event");
  id
}

// ---------------------------------------------------------------------------
// Workspace-targeted cleanup helper (P83-I-05)
// ---------------------------------------------------------------------------

async fn cleanup_document_outbox(pool: &PgPool, workspace_ids: &[Uuid]) {
  // Lifecycle and older event producers use different aggregate identities.
  // Payload scope also survives an earlier fixture document deletion, when
  // its aggregate ID can no longer be resolved through the docs table.
  sqlx::query(
    "DELETE FROM outbox_events
     WHERE (aggregate_type = 'doc'
       AND aggregate_id IN (SELECT id::text FROM docs WHERE workspace_id = ANY($1)))
        OR (event_type IN ('workspace_doc_broadcast', 'doc_updated', 'workspace_automation_trigger', 'task_recurrence_due')
         AND payload->>'workspaceId' IN (SELECT unnest($1::uuid[])::text))
       OR (event_type = 'database_task_notification'
         AND payload->'intent'->>'workspaceId' IN (SELECT unnest($1::uuid[])::text))",
  )
  .bind(workspace_ids)
  .execute(pool)
  .await
  .expect("cleanup fixture document broadcast/search outbox rows");
}

/// Delete the given workspace fixtures in FK order, including document intents.
/// Outbox cleanup must succeed; the existing row cleanup remains best-effort.
pub async fn cleanup_workspaces(pool: &PgPool, workspace_ids: &[Uuid]) {
  if workspace_ids.is_empty() {
    return;
  }
  cleanup_document_outbox(pool, workspace_ids).await;
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM document_version WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query(
    "DELETE FROM document_versioning_settings WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = ANY($1))",
  )
  .bind(workspace_ids)
  .execute(pool)
  .await
  .ok();
  sqlx::query("DELETE FROM doc_histories WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id IN (SELECT id FROM docs WHERE workspace_id = ANY($1))")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_doc_view_daily WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_member_last_access WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_invite_links WHERE workspace_id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(workspace_ids)
    .execute(pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// Multi-instance test helpers (P84-I-10/11)
// ---------------------------------------------------------------------------

/// Start a second API server on a random port, sharing the same PgPool.
///
/// Returns `(router, addr)` where:
/// - `router` can be used with `.oneshot()` in tests (in-process)
/// - `addr` is the bound `SocketAddr` — an HTTP server is spawned on it via
///   `tokio::spawn(axum::serve(...))` so external `reqwest` calls also work.
///
/// The second instance uses a fresh `instance_id` (different UUID from the
/// first), matching production multi-instance deployments.  Both instances
/// share the same database and Redis connection pool.
pub async fn spawn_second_server(pool: PgPool) -> (axum::Router, std::net::SocketAddr) {
  let config = AppConfig::load().expect("config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage-2").expect("storage-2"));
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(BlobService::new(blob_store, storage.clone(), "test-key".to_string()));

  let auth_service = AuthService::new(
    auth_store,
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);

  let state = wire_database_services(
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage,
    )
    .with_metrics_pool(pool.clone())
    .with_instance_id(uuid::Uuid::new_v4()),
    &pool,
    None,
    None,
  ); // distinct from instance A

  let router = build_router_for_integration_tests(state);

  // Also bind a real TCP listener so reqwest-based tests can hit the server
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
    .await
    .expect("bind second server");
  let addr = listener.local_addr().expect("local addr");
  let router_clone = router.clone();
  tokio::spawn(async move {
    axum::serve(listener, router_clone).await.expect("second server serve");
  });

  (router, addr)
}

/// Set up two API instances sharing the same PgPool + Redis.
///
/// Returns `(router_a, router_b, pool, redis_url)` where both routers are
/// independently usable via `.oneshot()`.  Use `router_b` for queries that
/// must run on the second instance (e.g. verifying Pub/Sub propagation).
pub async fn multi_instance_setup() -> (axum::Router, axum::Router, PgPool, String) {
  let pool = setup_pool().await;
  let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());

  let (router_a, _, _) = setup_app_with_pool(pool.clone()).await;
  let (router_b, _addr) = spawn_second_server(pool.clone()).await;

  (router_a, router_b, pool, redis_url)
}

/// Authenticated MCP HTTP fixtures shared by full and quick consumer builds.
pub mod mcp {
  use super::*;
  use axum::http::StatusCode;
  pub async fn request(app: &axum::Router, token: &str, method: &str, params: Value) -> (StatusCode, Value) {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/mcp")
          .header("content-type", "application/json")
          .header("authorization", format!("Bearer {token}"))
          .body(Body::from(
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
          ))
          .unwrap(),
      )
      .await
      .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
      status,
      if status != StatusCode::OK || bytes.is_empty() {
        Value::Null
      } else {
        serde_json::from_slice(&bytes).unwrap()
      },
    )
  }
  pub async fn invoke(app: &axum::Router, token: &str, name: &str, arguments: Value, success: bool) -> Value {
    let (status, response) = request(app, token, "tools/call", json!({"name":name,"arguments":arguments})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(response.get("error").is_none(), "tool protocol error");
    assert_eq!(
      response["result"]["isError"] == true,
      !success,
      "unexpected tool outcome: {name}"
    );
    response["result"]["structuredContent"].clone()
  }
  pub async fn key(app: &axum::Router, session: Uuid, scopes: &[&str]) -> String {
    let response = super::gql(app, session, json!({"query":"mutation($scopes:[String!]!){apiKeys{createApiKey(name:\"mcp:users-contract\",scopes:$scopes){key}}}","variables":{"scopes":scopes}})).await;
    assert!(response.get("errors").is_none(), "key issuance failed");
    response["data"]["apiKeys"]["createApiKey"]["key"]
      .as_str()
      .unwrap()
      .to_owned()
  }
}

/// Tests explicitly pack the authoring root once, then consume the same complete
/// native composition as startup. Production never resolves checkout paths.
pub fn feature_source_set() -> Arc<myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet> {
  use myoxus_domain::feature_bundle::{FeatureBundleCatalogSource, FeatureReleaseDescriptor};
  use myoxus_infrastructure::feature_bundles::{CapturedFeatureSourceSet, capture_feature_source};
  static SOURCES: OnceLock<Arc<CapturedFeatureSourceSet>> = OnceLock::new();
  SOURCES
    .get_or_init(|| {
      let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates");
      let base = capture_feature_source(&root, "features/base/manifest.yaml").expect("valid shipped Feature source");
      let release = FeatureReleaseDescriptor {
        format_version: 1,
        base: base.pin(),
      };
      let catalog = FeatureBundleCatalogSource {
        format_version: 1,
        base: base.pin(),
        optional: vec![],
        retained: vec![],
      };
      let bundles = vec![base];
      let resolved = myoxus_application::feature_bundle::assemble_feature_catalogs(&release, &catalog, &bundles)
        .expect("complete shipped native Feature selection");
      Arc::new(CapturedFeatureSourceSet {
        release,
        catalog,
        bundles,
        resolved,
      })
    })
    .clone()
}

pub fn database_starter_catalog() -> Arc<myoxus_application::database::DatabaseStarterTemplateCatalog> {
  Arc::new(feature_source_set().resolved.databases.clone())
}
