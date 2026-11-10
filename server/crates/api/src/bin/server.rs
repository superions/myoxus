//! `myoxus-api` server binary entry point.
//!
//! Reads layered configuration (YAML files + `MYOXUS__*` env overrides), sets up
//! structured logging with optional log-file rotation, runs startup checks
//! (database connectivity, blob-storage readiness), applies SQLx migrations, and
//! starts the Axum HTTP server. Graceful shutdown is handled via `tokio::signal`.

use myoxus_api::work_queue::RedisQueueAdapter;
use std::ffi::OsStr;
use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use myoxus_api::config::{AppConfig, LogRotation, RedisRole, StorageBackend, drain_startup_warnings};
use myoxus_api::startup_checks::{
  StartupCheckCategory, StartupCheckError, check_search_content_first_boot, verify_blob_storage_readiness,
  verify_database_readiness, verify_local_storage_free_space, verify_local_storage_path_readiness,
  verify_redis_readiness, verify_search_content_readiness,
};
use myoxus_api::state::{ApiState, StartupCheckSnapshot};
use myoxus_api::websocket::redis_adapter::RedisWsAdapter;
use myoxus_api::websocket::{SocketCalendarBroadcast, SocketReminderPort};
use myoxus_api::workspace_content_coordination::RedisWorkspaceContentQueueAdapter;
use myoxus_application::admin::AdminService;
use myoxus_application::api_key::ApiKeyService;
use myoxus_application::auth::AuthService;
use myoxus_application::calendar::{CalendarReminderDispatcher, CalendarService, NativeEventService};
use myoxus_application::comment::{AuthStoreCommentAdapter, CommentService};
use myoxus_application::copilot::CopilotService;
use myoxus_application::copilot::provider::LlmProviderRegistry;
use myoxus_application::database::{
  DatabaseLimits, DatabaseMutationEffects, DatabaseServiceDependencies, DatabaseServices,
};
use myoxus_application::doc::{DocCachePort, DocService};
use myoxus_application::document_graph::{DocumentGraphLimits, DocumentGraphService};
use myoxus_application::notification::NotificationService;
use myoxus_application::ports::{BlobStoragePort, DistributedLockPort, MailPort, PortError, PortResult, RedisPort};
use myoxus_application::search::SearchIndexerService;
use myoxus_application::worker::WorkQueuePort;
use myoxus_application::workspace::WorkspaceService;
use myoxus_application::workspace_automation::{WorkspaceAutomationLimits, WorkspaceAutomationService};
use myoxus_application::workspace_content_operation::authorization::WorkspaceContentAuthorizer;
use myoxus_application::workspace_content_operation::control::WorkspaceContentControlService;
use myoxus_application::workspace_content_operation::coordination::{
  WorkspaceContentCacheInvalidationPort, WorkspaceContentClusterCoordinator, WorkspaceContentRealtimePort,
  WorkspaceContentRealtimeSignal,
};
use myoxus_application::workspace_content_operation::copy::{
  WorkspaceContentCopyExecutor, WorkspaceContentCopySourceService,
};
use myoxus_application::workspace_content_operation::extract::WorkspaceContentExtractRecoveryService;
use myoxus_application::workspace_content_operation::link::{
  WorkspaceContentLinkExecutor, WorkspaceContentLinkService,
};
use myoxus_application::workspace_content_operation::move_publication::WorkspaceContentMovePublicationService;
use myoxus_application::workspace_content_operation::notification::WorkspaceContentNotificationDispatcher;
use myoxus_application::workspace_content_operation::organizer_stage::WorkspaceContentOrganizerStageExecutor;
use myoxus_application::workspace_content_operation::publication::{
  WorkspaceContentCopyPublicationService, WorkspaceContentOrganizerRevisionService,
};
use myoxus_application::workspace_content_operation::reconcile::{
  WorkspaceContentReconcileExecutor, WorkspaceContentReconcileSourceService,
};
use myoxus_application::workspace_content_operation::redirect::WorkspaceContentRedirectService;
use myoxus_application::workspace_content_operation::worker::WorkspaceContentWorkerService;
use myoxus_domain::workspace_content_operation::{
  WorkspaceContentErrorCode, WorkspaceContentOperationKind, WorkspaceContentOperationStatus,
  WorkspaceContentResourceKind, WorkspaceContentResourceRef,
};
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::api_key::SqlxApiKeyStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::comment::SqlxCommentRepository;
use myoxus_infrastructure::copilot::openai_provider::OpenAiProvider;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::doc_cache::{DocCache, RedisDocCacheConfig};
use myoxus_infrastructure::mail::{LogMailAdapter, SmtpMailAdapter};
use myoxus_infrastructure::notification::SqlxNotificationRepository;
use myoxus_infrastructure::outbox::SqlxOutboxEventPublisher;
use myoxus_infrastructure::search::SqlxSearchRepository;
use myoxus_infrastructure::storage::{S3StorageConfig, StorageAdapter};
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use myoxus_infrastructure::workspace_content_operation::{
  PgWorkspaceContentAuthorizationSource, PgWorkspaceContentCopyPublicationRepository, PgWorkspaceContentGraphSource,
  PgWorkspaceContentMovePublicationRepository, PgWorkspaceContentOperationRepository,
  PgWorkspaceContentRedirectRepository,
};
use myoxus_worker::{
  JobConfigSnapshot, RedisQueue, WorkerRuntime,
  config::{QueueConfig, RuntimeConfig},
};
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{debug, error, info, instrument, trace, warn};
use tracing_subscriber::{layer::SubscriberExt, reload, util::SubscriberInitExt};

const API_WORKER_THREAD_STACK_SIZE: usize = 8 * 1024 * 1024;

fn bundled_static_fonts_path() -> std::path::PathBuf {
  let relative = std::path::PathBuf::from("static/fonts");
  if relative.is_dir() {
    return relative;
  }
  let manifest_relative = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .and_then(|path| path.parent())
    .map(|server_root| server_root.join("static/fonts"));
  match manifest_relative {
    Some(path) if path.is_dir() => path,
    _ => relative,
  }
}

/// Initialise the global tracing subscriber.
///
/// Returns `(reload_fn, guard)` where `guard` is `Some` when a file sink is
/// active.  The guard **must** be kept alive for the duration of the program;
/// dropping it flushes and closes the background log-writer thread.
#[instrument(skip(config))]
fn init_tracing(
  config: &AppConfig,
) -> Result<
  (
    myoxus_api::logging::ReloadFn,
    Option<tracing_appender::non_blocking::WorkerGuard>,
  ),
  Box<dyn std::error::Error>,
> {
  let filter_str = std::env::var("RUST_LOG")
    .ok()
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| config.logging.level.clone());
  let env_filter = tracing_subscriber::EnvFilter::new(&filter_str);
  let stdout_layer = tracing_subscriber::fmt::layer();

  if let Some(path) = &config.logging.file_path {
    let log_path = Path::new(path);
    let directory = log_path
      .parent()
      .filter(|p| !p.as_os_str().is_empty())
      .unwrap_or(Path::new("."));
    std::fs::create_dir_all(directory)?;
    let stem = log_path
      .file_stem()
      .and_then(OsStr::to_str)
      .ok_or("logging.file_path must include a valid filename stem")?;
    let ext = log_path.extension().and_then(OsStr::to_str).unwrap_or("log");

    // Use the builder API so the filename becomes `{stem}.{date}.{ext}` (e.g.
    // `myoxus.2026-03-30.log`), which always ends with `.{ext}` regardless of
    // rotation mode.  The builder also handles automatic pruning via
    // `max_log_files`, replacing the old `prune_rotated_logs` startup pass.
    let rotation = match config.logging.rotation {
      LogRotation::Daily => tracing_appender::rolling::Rotation::DAILY,
      LogRotation::Hourly => tracing_appender::rolling::Rotation::HOURLY,
      LogRotation::Never => tracing_appender::rolling::Rotation::NEVER,
    };
    let max_files = if config.logging.rotation != LogRotation::Never {
      config.logging.max_files
    } else {
      0 // never-rotation: no pruning
    };
    let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
      .rotation(rotation)
      .filename_prefix(stem)
      .filename_suffix(ext)
      .max_log_files(max_files)
      .build(directory)
      .map_err(|e| format!("failed to create rolling file appender: {e}"))?;

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let file_layer = tracing_subscriber::fmt::layer()
      .with_ansi(false)
      .with_writer(non_blocking);

    let (filter_layer, reload_handle) = reload::Layer::new(env_filter);
    tracing_subscriber::registry()
      .with(filter_layer)
      .with(stdout_layer)
      .with(file_layer)
      .init();
    info!(
      log_dir = %directory.display(),
      log_stem = stem,
      rotation = ?config.logging.rotation,
      max_files = config.logging.max_files,
      "logging initialized with console and rolling-file sink (reload enabled)"
    );
    let reload_fn: myoxus_api::logging::ReloadFn = Arc::new(move |filter_str: &str| {
      let new_filter = tracing_subscriber::EnvFilter::new(filter_str);
      reload_handle
        .reload(new_filter)
        .map_err(|e| format!("failed to reload EnvFilter: {e}"))
    });
    return Ok((reload_fn, Some(guard)));
  }

  let (filter_layer, reload_handle) = reload::Layer::new(env_filter);
  tracing_subscriber::registry()
    .with(filter_layer)
    .with(stdout_layer)
    .init();
  info!("logging initialized with console sink (reload enabled)");
  let reload_fn: myoxus_api::logging::ReloadFn = Arc::new(move |filter_str: &str| {
    let new_filter = tracing_subscriber::EnvFilter::new(filter_str);
    reload_handle
      .reload(new_filter)
      .map_err(|e| format!("failed to reload EnvFilter: {e}"))
  });
  Ok((reload_fn, None))
}

#[instrument(skip(checks, detail))]
fn push_startup_check(
  checks: &mut Vec<StartupCheckSnapshot>,
  name: String,
  category: StartupCheckCategory,
  code: String,
  detail: impl Into<String>,
) {
  trace!("recording startup check snapshot");
  checks.push(StartupCheckSnapshot {
    name,
    status: "pass".to_string(),
    category,
    code,
    detail: detail.into(),
    checked_at: Utc::now(),
  });
}

#[instrument(skip(err))]
fn log_startup_failure(check_name: &str, err: &StartupCheckError) {
  error!(
    check_name,
    code = err.code(),
    category = ?err.category(),
    error = %err,
    "startup check failed"
  );
}

async fn shutdown_signal() {
  #[cfg(unix)]
  {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("static: install SIGTERM signal handler");
    tokio::select! {
      _ = tokio::signal::ctrl_c() => {},
      _ = terminate.recv() => {},
    }
  }
  #[cfg(not(unix))]
  {
    tokio::signal::ctrl_c()
      .await
      .expect("static: install shutdown signal handler");
  }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
  if std::env::args().nth(1).as_deref() == Some(myoxus_api::copilot_context_parser::PARSE_ARGUMENT) {
    return myoxus_api::copilot_context_parser::parse_child();
  }
  myoxus_infrastructure::tls::initialize_crypto_provider();
  let mut config = AppConfig::load()?;
  let additional_ca = myoxus_api::config::load_global_ca_bundle(&config)?;
  config.additional_ca = additional_ca.clone();
  if let Some(bundle) = &additional_ca {
    myoxus_infrastructure::git_sync::ca_bundle::initialize(bundle)?;
  }
  tokio::runtime::Builder::new_multi_thread()
    .thread_name("myoxus-api")
    .thread_stack_size(API_WORKER_THREAD_STACK_SIZE)
    .enable_all()
    .build()?
    .block_on(run(config, additional_ca))
}

async fn run(
  mut config: AppConfig,
  additional_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<(), Box<dyn std::error::Error>> {
  // `_log_guard` keeps the non-blocking file-appender writer thread alive.
  // It must remain in scope until the end of main().
  let (reload_fn, _log_guard) = init_tracing(&config)?;
  // Emit any warnings that were buffered before the tracing subscriber was ready.
  drain_startup_warnings();

  // Build the LoggingService from config and the reload handle.
  let logging_service = {
    use myoxus_api::logging::{LogLevel, LoggingService};
    use std::collections::HashMap;
    use std::str::FromStr as _;
    let global_level =
      LogLevel::from_str(config.logging.level.split(',').next().unwrap_or("info")).unwrap_or(LogLevel::Info);
    // No per-module config overrides yet — all groups use recommended defaults.
    let config_modules: HashMap<String, String> = HashMap::new();
    Arc::new(LoggingService::new_with_max_history(
      &config_modules,
      global_level,
      reload_fn,
      config.logging.max_history,
    ))
  };

  // STRUCT-09: Reject well-known placeholder private key in production
  let run_mode = std::env::var("RUN_MODE").unwrap_or_else(|_| "development".into());
  if config.crypto.private_key == "myoxus-change-me-private-key" {
    if run_mode == "production" {
      error!(
        "FATAL: crypto.private_key is set to the default placeholder. Set MYOXUS__CRYPTO__PRIVATE_KEY to a unique secret before running in production."
      );
      return Err("insecure default crypto.private_key in production".into());
    }
    warn!(
      "crypto.private_key is set to the default placeholder — acceptable for development, but MUST be changed for production"
    );
  }

  let mut startup_checks: Vec<StartupCheckSnapshot> = Vec::new();
  info!(
    max_connections = config.database.max_connections,
    min_connections = config.database.min_connections,
    acquire_timeout_seconds = config.database.acquire_timeout_seconds,
    "connecting to postgres with pool options"
  );
  let pool = PgPoolOptions::new()
    .max_connections(config.database.max_connections)
    .min_connections(config.database.min_connections)
    .acquire_timeout(std::time::Duration::from_secs(config.database.acquire_timeout_seconds))
    .connect_with(myoxus_infrastructure::tls::postgres::connect_options(
      &config.database.url,
      config.additional_ca.as_ref(),
    )?)
    .await?;

  // Run database migrations before any readiness checks
  info!("applying database migrations");
  myoxus_infrastructure::migrations::run(&pool).await.map_err(|e| {
    error!(error = %e, "database migration failed");
    Box::new(e) as Box<dyn std::error::Error>
  })?;
  info!("database migrations applied successfully");
  let reminder_roots = myoxus_infrastructure::scheduling::reminders::initialize(&pool).await?;
  info!(reminder_roots, "Calendar reminder timing initialized before workers");

  // Infrastructure bootstrap uses the file/ENV snapshot. Once PostgreSQL is
  // reachable, all registered DB overrides are applied once and deserialized
  // back into the final typed AppConfig before business services are built.
  let file_config = config.clone();
  let startup_app_config_values = myoxus_infrastructure::app_config::load_validated_app_config_values(&pool).await?;
  config = config.with_database_overrides(&startup_app_config_values)?;
  // Resolve once from the merged startup snapshot. Live saves never reload catalogs.
  let configured_root = std::path::Path::new(&config.templates.root_dir);
  let template_root = if configured_root.is_absolute() {
    configured_root.to_path_buf()
  } else {
    std::env::current_dir()?.join(configured_root)
  };
  // The executable-owned expectation must match the single mounted pointer
  // before any Registry publication, managed reconciliation or traffic starts.
  let feature_sources = Arc::new(myoxus_infrastructure::feature_bundles::capture_feature_source_set(
    &template_root,
    &myoxus_infrastructure::feature_bundles::packaged_feature_release_manifest()?,
  )?);
  let database_starter_catalog = Arc::new(feature_sources.resolved.databases.clone());
  let assistant_package_catalog = Arc::new(feature_sources.resolved.assistants.clone());
  let html_catalog = Arc::new(myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
    template_root.join("html"),
  ));
  myoxus_public_render::HtmlRendererProvider::renderer(html_catalog.as_ref())
    .map_err(|error| format!("HTML template catalog: {error}"))?;
  let mail_directory = template_root.join("mail");
  let mail_template_renderer = Arc::new(
    myoxus_infrastructure::mail::MailTemplateRenderer::new(
      mail_directory.to_str().ok_or("mail template path must be UTF-8")?,
    )
    .map_err(|error| format!("mail template catalog {}: {error}", mail_directory.display()))?,
  );
  let config_overrides = Arc::new(tokio::sync::RwLock::new(
    myoxus_api::config_reload::ConfigOverrides::from_sources(&file_config, &startup_app_config_values),
  ));
  logging_service
    .apply_canonical_filter(&config.logging.level)
    .await
    .map_err(|error| format!("failed to apply canonical startup logging.level: {error}"))?;
  info!(
    override_count = startup_app_config_values.len(),
    "materialized canonical database configuration overrides"
  );

  let git_sync_ca_bundle = if config.tls.additional_ca_bundle_path.is_some() {
    additional_ca.clone()
  } else {
    myoxus_api::config::materialize_git_sync_https_ca_bundle(&config)?
  };
  if let Some(bundle) = &git_sync_ca_bundle {
    info!(
      canonical_path = %bundle.canonical_path.display(),
      certificate_count = bundle.certificate_count,
      snapshot_id = %bundle.snapshot_id,
      source = if config.tls.additional_ca_bundle_path.is_some() {
        "bootstrap_file_env"
      } else {
        "legacy_git_only_migration_required"
      },
      policy = "additional_ca_plus_system_roots",
      restart_required = true,
      "materialized restart-bound Git-Sync HTTPS CA bundle"
    );
  }
  let trust_source = config.source_snapshot.resolve(
    myoxus_contracts::effective_config::find_descriptor("tls.additional_ca_bundle_path")
      .expect("registered TLS setting"),
    &std::collections::HashMap::new(),
  )?;
  push_startup_check(
    &mut startup_checks,
    "additional_ca_trust".to_string(),
    StartupCheckCategory::Config,
    if config.tls.additional_ca_bundle_path.is_none() && startup_app_config_values.contains_key("git_sync.https_ca_bundle_path") {
      "tls_legacy_git_migration_required"
    } else {
      "tls_bootstrap_loaded"
    }
    .to_string(),
    serde_json::json!({
      "source": trust_source.winning_source,
      "source_key": trust_source.winning_key,
      "additional_ca_count": additional_ca.as_ref().map_or(0, |bundle| bundle.certificate_count),
      "legacy_git_ca_count": if config.tls.additional_ca_bundle_path.is_none() { git_sync_ca_bundle.as_ref().map_or(0, |bundle| bundle.certificate_count) } else { 0 },
      "snapshot_id": additional_ca.as_ref().map_or("library-public-roots", |bundle| bundle.snapshot_id.as_str()),
      "restart_required": true,
      "transport_cutover_complete": false
    })
    .to_string(),
  );
  let git_token_rotation_service = Arc::new(myoxus_application::git_sync::GitTokenRotationService::new(
    Arc::new(myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone())),
    Arc::new(myoxus_infrastructure::git_sync::GitSyncTokenCredentialCodec::new(
      config.crypto.private_key.clone(),
    )),
    vec![Arc::new(
      myoxus_infrastructure::git_sync::GitLabTokenRotationAdapter::new(
        std::time::Duration::from_secs(config.git_sync.network_timeout_secs),
        git_sync_ca_bundle.as_ref(),
      )?,
    )],
  ));
  let password_reset_ttl_seconds = config.auth.password_reset_ttl_seconds;
  info!(
    password_reset_ttl_seconds,
    source = if startup_app_config_values.contains_key("auth.password_reset_ttl_seconds") {
      "database_override"
    } else {
      "server_config"
    },
    "materialized restart-bound password-reset policy"
  );

  // P-THEME-DB-SRV-02/03: materialize the server-owned theme, typography and
  // font catalog before readiness so runtime projections can rely on DB rows
  // instead of client-side presets or ad-hoc app_configs branding JSON.
  match myoxus_infrastructure::branding::seed_system_theme_branding(&pool).await {
    Ok(stats) if stats.total_rows_materialized() == 0 => debug!("P-THEME-DB: theme branding catalog already seeded"),
    Ok(stats) => info!(
      font_families = stats.font_families,
      font_assets = stats.font_assets,
      color_schemas = stats.color_schemas,
      color_values = stats.color_values,
      typography_sets = stats.typography_sets,
      typography_styles = stats.typography_styles,
      themes = stats.themes,
      global_profile_created = stats.global_profile_created,
      "P-THEME-DB: theme branding catalog seeded"
    ),
    Err(err) => {
      error!(error = %err, "P-THEME-DB: failed to seed theme branding catalog");
      return Err(format!("failed to seed theme branding catalog: {err}").into());
    }
  }

  match myoxus_infrastructure::document_metadata::sync_document_default_language_from_locale(
    &pool,
    &config.i18n.default_locale,
    &myoxus_api::config::AppConfigStartupValidator,
  )
  .await
  {
    Ok(stats) => info!(
      configured_locale = %stats.configured_locale,
      resolved_language = %stats.resolved_language_key,
      organization_defaults_updated = stats.organization_defaults_updated,
      "document metadata default language synchronized from server i18n config"
    ),
    Err(err) => {
      error!(error = %err, "failed to synchronize document metadata default language");
      return Err(format!("failed to synchronize document metadata default language: {err}").into());
    }
  }

  if let Err(err) = verify_database_readiness(&pool).await {
    log_startup_failure("database_readiness", &err);
    return Err(Box::new(err) as Box<dyn std::error::Error>);
  }
  push_startup_check(
    &mut startup_checks,
    "database_readiness".to_string(),
    StartupCheckCategory::Permissions,
    "database_readiness_passed".to_string(),
    "database connectivity, schema, and privileges verified",
  );
  // The check is intentionally unconditional (not gated on `indexer.enabled`):
  //   - The `search_content` table is always created by migrations and is
  //     expected to exist regardless of whether indexing is active.
  //   - The "indexer" is not a remote/external service — it is backed entirely
  //     by PostgreSQL FTS + pgvector (no separate process, no remote socket).
  //     Its readiness is therefore equivalent to database readiness.
  //   - `indexer.enabled` only controls whether new indexing jobs are enqueued;
  //     it does NOT mean canonical search content is absent.
  //
  // Conscious decision: no separate indexer-specific connectivity check is
  // needed at startup. The DB readiness check above already covers the
  // infrastructure. See `docs/dev/server/production-readiness.md` for the
  // architectural rationale.
  if let Err(err) = verify_search_content_readiness(&pool).await {
    log_startup_failure("search_content_readiness", &err);
    return Err(Box::new(err) as Box<dyn std::error::Error>);
  }
  push_startup_check(
    &mut startup_checks,
    "search_content_readiness".to_string(),
    StartupCheckCategory::Permissions,
    "search_content_readiness_passed".to_string(),
    "search_content table and FTS operators verified",
  );
  let redis_adapters = match verify_redis_readiness(&config.redis, config.additional_ca.as_ref()).await {
    Ok(adapters) => adapters,
    Err(err) => {
      log_startup_failure("redis_readiness", &err);
      return Err(Box::new(err) as Box<dyn std::error::Error>);
    }
  };

  // One startup-owned UUID identifies this process in every cluster adapter.
  // It is intentionally regenerated after each restart and never derived from
  // a hostname, which may be shared by multiple replicas.
  let instance_id = uuid::Uuid::new_v4();
  let cache_adapter = redis_adapters.cache.map(Arc::new);
  let session_adapter: Arc<dyn RedisPort> = Arc::new(redis_adapters.session);
  let queue_client = redis_adapters.queue.client().clone();
  let queue_namespace = config.redis.role_namespace(RedisRole::Queue);
  let socket_adapter = redis_adapters.socket.map(Arc::new);
  let socket_enabled = socket_adapter.is_some();
  let redis_ws_adapter = socket_adapter
    .as_ref()
    .map(|adapter| Arc::new(RedisWsAdapter::new(instance_id, adapter.clone())));
  let lock_adapter = Arc::new(redis_adapters.lock);
  let lock_redis: Arc<dyn RedisPort> = lock_adapter.clone();
  let distributed_lock_adapter: Arc<dyn DistributedLockPort> = lock_adapter;

  push_startup_check(
    &mut startup_checks,
    "redis_readiness".to_string(),
    StartupCheckCategory::Network,
    "redis_readiness_passed".to_string(),
    "redis enabled and reachable for cache/session/queue/socket/lock profiles",
  );
  info!(
    cache_namespace = %config.redis.role_namespace(RedisRole::Cache),
    cache_enabled = cache_adapter.is_some(),
    session_namespace = %config.redis.role_namespace(RedisRole::Session),
    queue_namespace = %queue_namespace,
    socket_namespace = %config.redis.role_namespace(RedisRole::Socket),
    socket_enabled,
    lock_namespace = %config.redis.role_namespace(RedisRole::Lock),
    "redis role profiles initialized"
  );

  let (redis_port, distributed_lock): (Arc<dyn RedisPort>, Arc<dyn DistributedLockPort>) =
    (session_adapter, distributed_lock_adapter);
  let store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(pool.clone(), database_starter_catalog.clone()));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  // Build the document and blob stores with the canonical workspace quota
  // hierarchy. When a Redis cache
  // adapter is available, `.with_quota_cache()` avoids a DB round-trip on every
  // write by caching the resolved quota and usage in Redis.
  let default_ws_quota_mb = config.storage.default_workspace_quota_mb;

  let doc_store_inner = SqlxDocStore::new(pool.clone())
    .with_field_capture_default_locale(config.i18n.default_locale.clone())
    .with_database_templates(database_starter_catalog.clone())
    .with_quota_config(default_ws_quota_mb);
  // Finish references left by permanent deletions in older releases. This is
  // automatic, idempotent deletion catch-up, never restoration or a manual task.
  if doc_store_inner.purge_legacy_deleted_organizer_links().await.is_err() {
    tracing::error!(
      phase = "permanent_delete_cleanup",
      cause = "DOC_DELETE_ORGANIZER_INVENTORY_FAILED",
      "document_delete.organizer_startup_cleanup_failed"
    );
  }
  let blob_store_inner =
    myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone()).with_quota_config(default_ws_quota_mb);

  // Wire the quota Redis cache if the cache Redis role is configured.
  let (doc_store_inner, blob_store_inner) = if let Some(cache) = cache_adapter.as_ref() {
    let redis_port: Arc<dyn myoxus_application::ports::RedisPort> = cache.clone();
    let quota_cache = Arc::new(myoxus_infrastructure::quota_cache::QuotaCache::with_all_ttls(
      redis_port,
      &config.redis.namespace,
      config.redis.cache_ttl_quota_seconds,
      config.redis.cache_ttl_usage_seconds,
      config.redis.cache_ttl_git_status_seconds,
    ));
    info!(
      "P112-QUOTA: QuotaCache wired into doc_store + blob_store \
       (quota_ttl={}s usage_ttl={}s)",
      config.redis.cache_ttl_quota_seconds, config.redis.cache_ttl_usage_seconds,
    );
    (
      doc_store_inner.with_quota_cache(quota_cache.clone()),
      blob_store_inner.with_quota_cache(quota_cache),
    )
  } else {
    info!("P112-QUOTA: no cache Redis — QuotaCache dormant, quota resolved from DB on every write");
    (doc_store_inner, blob_store_inner)
  };

  let doc_store = Arc::new(doc_store_inner);
  let comment_store = Arc::new(SqlxCommentRepository::new(pool.clone()));
  let notification_store = Arc::new(SqlxNotificationRepository::new(pool.clone()));
  let blob_store = Arc::new(blob_store_inner);
  let outbox_events = Arc::new(SqlxOutboxEventPublisher::new(pool.clone()));

  let mailer: Arc<dyn MailPort> = if config.mail.smtp_host.is_some() {
    Arc::new(
      SmtpMailAdapter::with_renderer(
        config
          .mail
          .clone()
          .into_adapter_config(mail_template_renderer.directory().into()),
        config.additional_ca.clone(),
        mail_template_renderer.clone(),
      )
      .with_rendering_config(config.server.origin.clone(), config.i18n.default_locale.clone()),
    )
  } else {
    Arc::new(LogMailAdapter)
  };

  let storage_adapter: Arc<StorageAdapter> = match config.storage.backend {
    StorageBackend::S3 | StorageBackend::R2 => {
      let bucket = config
        .storage
        .bucket
        .as_deref()
        .ok_or("storage.bucket is required for s3/r2 backend")?;
      info!(
          backend = ?config.storage.backend,
          bucket,
          prefix = ?config.storage.prefix,
          endpoint = ?config.storage.endpoint,
          signed_url_ttl_seconds = config.storage.signed_url_ttl_seconds,
          "initializing object storage backend"
      );
      Arc::new(StorageAdapter::new_s3(
        S3StorageConfig {
          bucket,
          prefix: config.storage.prefix.as_deref(),
          endpoint: config.storage.endpoint.as_deref(),
          region: config.storage.region.as_deref(),
          access_key: config.storage.access_key.as_deref(),
          secret_key: config.storage.secret_key.as_deref(),
          io_timeout_seconds: Some(config.storage.io_timeout_seconds),
          max_retries: Some(config.storage.s3_max_retries),
        },
        config.additional_ca.as_ref(),
      )?)
    }
    StorageBackend::Local => {
      let root = config.storage.root.as_deref().unwrap_or("./storage");
      if let Err(err) = verify_local_storage_path_readiness(root) {
        log_startup_failure("local_storage_path_readiness", &err);
        return Err(Box::new(err) as Box<dyn std::error::Error>);
      }
      push_startup_check(
        &mut startup_checks,
        "local_storage_path_readiness".to_string(),
        StartupCheckCategory::Permissions,
        "local_storage_path_ready".to_string(),
        format!("local storage root validated: {root}"),
      );
      if let Err(err) = verify_local_storage_free_space(root, config.storage.min_free_space_bytes()) {
        log_startup_failure("local_storage_free_space", &err);
        return Err(Box::new(err) as Box<dyn std::error::Error>);
      }
      push_startup_check(
        &mut startup_checks,
        "local_storage_free_space".to_string(),
        StartupCheckCategory::Storage,
        "local_storage_free_space_ok".to_string(),
        format!(
          "free space threshold satisfied: {} MB",
          config.storage.min_free_space_mb
        ),
      );
      info!(
          backend = ?config.storage.backend,
          root,
          min_free_space_mb = config.storage.min_free_space_mb,
          signed_url_ttl_seconds = config.storage.signed_url_ttl_seconds,
          "initializing local filesystem storage backend"
      );
      Arc::new(StorageAdapter::new_fs(root)?)
    }
  };
  // Snapshot the opendal operator for typed sub-stores (PDF blob store) before
  // we upcast the adapter to the BlobStoragePort trait object.
  let storage_operator = storage_adapter.operator();
  let storage: Arc<dyn myoxus_application::ports::BlobStoragePort> = storage_adapter.clone();
  if let Err(err) = verify_blob_storage_readiness(storage.as_ref()).await {
    log_startup_failure("blob_storage_readiness", &err);
    return Err(Box::new(err) as Box<dyn std::error::Error>);
  }
  push_startup_check(
    &mut startup_checks,
    "blob_storage_readiness".to_string(),
    StartupCheckCategory::Storage,
    "blob_storage_probe_ok".to_string(),
    "blob write/read/delete probe succeeded",
  );

  let auth_service = AuthService::new_with_token_ttls(
    store.clone(),
    mailer.clone(),
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
    config.server.magic_link_ttl_seconds,
    password_reset_ttl_seconds,
  )?
  .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
    locale: config.i18n.default_locale.clone(),
    ..Default::default()
  })
  .with_password_policy_provider(Arc::new(myoxus_api::config_reload::RuntimePasswordPolicyProvider::new(
    config.auth.password_requirements.clone(),
    config_overrides.clone(),
  )))
  .with_session_revocation_observer(Arc::new(myoxus_api::websocket::WebsocketSessionRevocationObserver))
  .with_session_revocation_effects(Arc::new(
    myoxus_infrastructure::cache_invalidation::RedisSessionRevocationEffects::new(cache_adapter.clone(), instance_id),
  ));
  let workspace_service = WorkspaceService::new_with_events(workspace_store.clone(), outbox_events.clone());
  let admin_service = AdminService::new(admin_store);
  // P103-D-01: Wire DocCache into DocService so all P102-CACHE caches are
  // active in production. Gracefully skipped when the cache Redis role is not
  // configured (single-instance / dev deployments without Redis).
  let doc_cache_config = RedisDocCacheConfig {
    snapshot_enabled: config.redis.doc_snapshot_cache_enabled,
    snapshot_ttl: config.redis.cache_ttl_doc_snapshot_seconds,
    snapshot_max_size_bytes: (config.redis.doc_snapshot_cache_max_size_mb as usize) * 1024 * 1024,
    metadata_enabled: config.redis.doc_metadata_cache_enabled,
    metadata_ttl: config.redis.cache_ttl_doc_metadata_seconds,
    metadata_projection_enabled: config.redis.doc_metadata_projection_cache_enabled,
    metadata_projection_ttl: config.redis.cache_ttl_doc_metadata_projection_seconds,
    document_metadata_index_enabled: config.redis.document_metadata_index_cache_enabled,
    document_metadata_index_ttl: config.redis.cache_ttl_document_metadata_index_seconds,
    document_metadata_index_max_size_bytes: (config.redis.document_metadata_index_cache_max_size_mb as usize)
      * 1024
      * 1024,
    view_dedup_enabled: config.redis.doc_view_dedup_enabled,
    compaction_lock_enabled: config.redis.compaction_lock_enabled,
    compaction_lock_ttl: config.redis.compaction_lock_ttl_seconds,
    timestamps_enabled: config.redis.doc_timestamps_cache_enabled,
    timestamps_ttl: config.redis.cache_ttl_doc_timestamps_seconds,
    timestamps_max_docs: config.redis.doc_timestamps_cache_max_docs as usize,
  };
  // P0-04: create the existing server-wide metrics service before DocService
  // so rejected external Yjs ingress is recorded in the same recorder and
  // persistence pipeline as every other collaboration metric.
  let metrics_service = {
    let metrics_cfg = &config.metrics;
    let policy = myoxus_application::metrics::MetricsPolicy {
      enabled: metrics_cfg.enabled,
      categories: metrics_cfg.categories.clone(),
      label_workspace_id_enabled: metrics_cfg.label_workspace_id_enabled,
      cardinality_limit_per_metric: metrics_cfg.cardinality_limit_per_metric,
    };
    let recorder = std::sync::Arc::new(myoxus_application::metrics::InMemoryMetricsRecorder::new(policy));
    let repo: std::sync::Arc<dyn myoxus_domain::metrics::MetricsRepository> =
      std::sync::Arc::new(myoxus_infrastructure::metrics::SqlxMetricsRepository::new(pool.clone()));
    std::sync::Arc::new(myoxus_application::metrics::MetricsService::new(recorder, repo))
  };
  let doc_service = DocService::new_with_decoder_concurrency(doc_store, config.doc.decoder_concurrency)
    .expect("validated doc.decoder_concurrency must fit the decoder gate")
    .with_compaction_thresholds(
      config.redis.compaction_threshold_default as usize,
      config.redis.compaction_threshold_root_doc as usize,
    )
    .with_external_update_ingress_max_bytes(
      config
        .doc
        .ingress
        .max_update_bytes()
        .expect("validated doc.ingress.max_update_mb must fit usize and be non-zero"),
    )
    .with_metrics_service(metrics_service.clone());
  let (doc_service, doc_cache_tuning_handles, doc_metadata_projection_cache) = if let Some(cache_redis) =
    cache_adapter.as_ref()
  {
    let redis_port: Arc<dyn myoxus_application::ports::RedisPort> = cache_redis.clone();
    let doc_cache = Arc::new(DocCache::new(redis_port, "myoxus", &doc_cache_config));
    let tuning_handles = doc_cache.tuning_handles();
    let projection_cache: Arc<dyn DocCachePort> = doc_cache.clone();
    info!(
      "P103-D-01: DocCache wired into DocService (snapshot/metadata/metadata_projection/view_dedup/compaction_lock/timestamps)"
    );
    info!("P104-C: DocCacheTuningHandles extracted for auto-tuning and admin TTL overrides");
    (
      doc_service.with_doc_cache(doc_cache),
      Some(tuning_handles),
      Some(projection_cache),
    )
  } else {
    warn!("P103-D-01: cache Redis not configured — DocCache dormant, all caches disabled");
    (doc_service, None, None)
  };
  let permission_service = Arc::new(myoxus_application::permission::PermissionService::new(
    auth_service.store.clone(),
  ));
  let database_repo = Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(
    pool.clone(),
    database_starter_catalog.clone(),
  ));
  let notification_projector = myoxus_application::notification::mail::NotificationMailProjector::new(store.clone())
    .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
      locale: config.i18n.default_locale.clone(),
      ..Default::default()
    })
    .with_services(
      workspace_service.clone(),
      doc_service.clone(),
      permission_service.clone(),
    )
    .with_database_repository(database_repo.clone(), database_repo.clone());
  let notification_service = Arc::new(NotificationService::new_with_email(
    notification_store,
    mailer.clone(),
    notification_projector,
    config.mail.enable_notification_emails
      && config
        .mail
        .smtp_host
        .as_deref()
        .is_some_and(|host| !host.trim().is_empty()),
  ));
  // P-DB-24: keep an extra handle so the database service can be wired with
  // the same notification service after the rest of `with_services_and_comment`
  // consumes the primary `notification_service` reference.
  let notification_service_for_db = notification_service.clone();
  let auth_adapter = Arc::new(AuthStoreCommentAdapter::new_with_permission_service(
    auth_service.store.clone(),
    permission_service.clone(),
  ));
  let comment_service = Arc::new(CommentService::new_with_mentions(
    comment_store,
    auth_adapter.clone(),
    auth_adapter,
  ));
  let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
    blob_store.clone(),
    storage.clone(),
    config.server.origin.clone(),
  ));
  let search_repository = Arc::new(SqlxSearchRepository::new(pool.clone()));
  search_repository.enqueue_field_refresh().await?;
  let calendar_repository = Arc::new(SqlxCalendarRepository::new(pool.clone()));
  let calendar_service = Arc::new(CalendarService::new(calendar_repository.clone()));
  let calendar_mail_dispatcher = myoxus_application::calendar::mail::CalendarSchedulingMailDispatcher::new(
    calendar_repository.clone(),
    store.clone(),
    workspace_store.clone(),
    mailer.clone(),
    config.mail.enable_notification_emails,
    config.mail.sender.clone(),
    myoxus_infrastructure::caldav::ical_serializer::calendar_event_to_scheduling,
    myoxus_infrastructure::caldav::ical_serializer::normalize_scheduling_mailbox,
  )
  .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
    locale: config.i18n.default_locale.clone(),
    ..Default::default()
  });

  let native_event_auth_store = auth_service.store.clone();

  let api_key_service = ApiKeyService::new(std::sync::Arc::new(SqlxApiKeyStore::new(pool.clone())));

  // Build the LLM provider registry from copilot config.
  let (llm_provider_registry, _default_model) = build_llm_provider_registry(&config);

  let state = ApiState::with_services_comment_and_permission(
    config.clone(),
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    comment_service,
    notification_service,
    blob_service,
    storage,
    permission_service,
  )
  .with_mail_template_renderer(mail_template_renderer)
  .with_html_catalog(html_catalog)
  .with_instance_id(instance_id)
  .with_search_repository(search_repository.clone())
  .with_calendar_service(calendar_service)
  .with_metrics_pool(pool.clone())
  .with_config_overrides_handle(config_overrides)
  .with_config_file_baseline(file_config.clone())
  .with_redis_port(redis_port.clone())
  .with_telemetry_service({
    // P-Telemetry-B: production ingest service — Postgres repo + Redis
    // dedupe store.  The `redis_port` handle is shared with the cache/lock
    // layer so dedupe entries land under the same Redis instance.
    let repo = std::sync::Arc::new(myoxus_infrastructure::telemetry::SqlxTelemetryRepository::new(
      pool.clone(),
    ));
    let dedupe = std::sync::Arc::new(myoxus_infrastructure::telemetry::RedisTelemetryDedupeStore::new(
      redis_port.clone(),
    ));
    std::sync::Arc::new(myoxus_application::telemetry::TelemetryIngestService::new(repo, dedupe))
  })
  .with_metrics_service(metrics_service)
  .with_distributed_lock(distributed_lock)
  .with_api_key_service(api_key_service)
  .with_git_token_rotation_service(git_token_rotation_service.clone())
  .with_llm_provider_registry(llm_provider_registry)
  .with_logging(logging_service);
  let native_event_service = Arc::new(
    NativeEventService::new(calendar_repository.clone(), native_event_auth_store).with_broadcast(Arc::new(
      SocketCalendarBroadcast::new(redis_ws_adapter.clone(), state.socket_io.clone()),
    )),
  );
  let state = state.with_native_event_service(native_event_service);

  let database_limits = DatabaseLimits {
    max_fields_per_database: config.databases.max_fields_per_database,
    max_views_per_database: config.databases.max_views_per_database,
    default_rows_per_page: config.databases.default_rows_per_page,
    max_rows_per_page: config.databases.max_rows_per_page,
    max_cell_text_bytes: config.databases.max_cell_text_bytes,
    csv_max_bytes: config.databases.csv_max_bytes,
    csv_max_rows: config.databases.csv_max_rows,
    csv_max_columns: config.databases.csv_max_columns,
    csv_sample_rows_for_type_inference: config.databases.csv_sample_rows_for_type_inference,
    notion_max_bytes: config.databases.notion_max_bytes,
    max_reminders_per_user_per_cell: config.databases.max_reminders_per_user_per_cell,
    max_reminder_offset_minutes: config.databases.max_reminder_offset_minutes,
    ..DatabaseLimits::default()
  };
  let database_doc_service = state.doc().clone();
  let database_permission_service = state.permission_service();
  let workspace_tag_repo: Arc<dyn myoxus_domain::workspace_tags::WorkspaceTagRepository> =
    Arc::new(myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository::new(
      pool.clone(),
      database_starter_catalog.clone(),
    ));
  let database_change_notifications: Arc<
    dyn myoxus_application::ports::database_change::DatabaseChangeNotificationPort,
  > = Arc::new(myoxus_api::websocket::SocketDatabaseBroadcast::new(
    redis_ws_adapter.clone(),
  ));
  let workspace_tag_service = Arc::new(
    myoxus_application::workspace_tags::WorkspaceTagService::new(
      workspace_tag_repo.clone(),
      database_permission_service.clone(),
    )
    .with_post_commit_effects(
      database_doc_service.doc_cache().cloned(),
      database_change_notifications.clone(),
    ),
  );
  let state = state.with_workspace_tag_service(workspace_tag_service.clone());

  // SC-M-01: Wire the Redis socket adapter for cross-instance WebSocket state.
  // The default redis.url also supplies this role. A missing role-specific
  // adapter disables cross-instance socket coordination, not Redis itself.
  let state = if let Some(ws_adapter) = redis_ws_adapter {
    info!("SC-M-01: Redis WebSocket adapter enabled for cross-instance coordination");
    state.with_redis_ws_adapter(ws_adapter)
  } else {
    info!("SC-M-01: Redis Socket role not configured; cross-instance socket coordination unavailable");
    state
  };
  // P84-I: Wire the cache invalidation bus for cross-instance cache sync.
  // Uses the cache Redis adapter. If no cache adapter is configured,
  // invalidation remains local-only (single-instance deployment).
  let state = if let Some(adapter) = cache_adapter.as_ref() {
    let bus = Arc::new(myoxus_api::cache_bus::CacheInvalidationBus::new(
      instance_id,
      adapter.clone(),
    ));
    info!(%instance_id, "P84-I: CacheInvalidationBus enabled for cross-instance cache sync");
    // P84-I-II: Also wire the cache Redis adapter for three-tier caching (L2).
    let adapter_port: Arc<dyn myoxus_application::ports::RedisPort> = adapter.clone();
    info!("P84-I-II: Redis L2 cache layer enabled for three-tier caching");
    state.with_cache_bus(bus).with_cache_redis(adapter_port)
  } else {
    info!("P84-I: No cache Redis adapter — cache invalidation is local-only, L2 cache disabled");
    state
  };

  // Always create the template registry service so it can be enabled at
  // runtime via the admin GUI (app_configs DB toggle) without server restart.
  // The enabled/disabled check happens at handler time, not at startup.
  let template_store = Arc::new(myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore::new(pool.clone()));
  let template_zip_limits = myoxus_application::template_registry::TemplateRegistryZipLimits {
    max_entries: config.template_registry.zip_limits.max_entries,
    max_total_uncompressed_size_mb: config.template_registry.zip_limits.max_total_uncompressed_size_mb,
    max_entry_uncompressed_size_mb: config.template_registry.zip_limits.max_entry_uncompressed_size_mb,
    max_compression_ratio: config.template_registry.zip_limits.max_compression_ratio,
    max_path_length: config.template_registry.zip_limits.max_path_length,
  };
  let mut template_service = myoxus_application::template_registry::TemplateRegistryService::new(template_store)
    .with_materialization(state.doc().clone(), state.storage().clone())
    .with_asset_materialization(state.blob_service())
    .with_telemetry(state.telemetry_arc())
    .with_zip_limits(template_zip_limits);
  if let Some(adapter) = socket_adapter {
    template_service = template_service.with_builder_notifications(Arc::new(
      myoxus_infrastructure::redis::workspace_broadcast::RedisTemplateBuilderNotifications(adapter),
    ));
  }
  info!(
    config_enabled = state.config.template_registry.enabled,
    zip_max_entries = template_zip_limits.max_entries,
    zip_max_total_uncompressed_size_mb = template_zip_limits.max_total_uncompressed_size_mb,
    zip_max_entry_uncompressed_size_mb = template_zip_limits.max_entry_uncompressed_size_mb,
    zip_max_compression_ratio = template_zip_limits.max_compression_ratio,
    zip_max_path_length = template_zip_limits.max_path_length,
    "template registry service created (runtime-toggleable via admin settings)"
  );
  let state = state
    .with_template_registry_service(template_service.clone())
    .with_feature_sources(feature_sources.clone());

  // P113-AUDIT: Wire the real PgAuditLogStore-backed recorder once the DB pool is available.
  let state = {
    let audit_store = myoxus_infrastructure::audit::PgAuditLogStore::new(pool.clone());
    let recorder = myoxus_application::audit::AuditRecorder::new(std::sync::Arc::new(audit_store));
    state.with_audit_recorder(recorder)
  };

  // P-DB-24: wire the Postgres-backed database activity recorder.
  let state = {
    let activity_store: Arc<dyn myoxus_domain::database_activity::DatabaseActivityStore> = Arc::new(
      myoxus_infrastructure::database_activity::PgDatabaseActivityStore::new(pool.clone()),
    );
    let recorder = myoxus_application::database::activity::DatabaseActivityRecorder::new(activity_store);
    state.with_database_activity_recorder(recorder)
  };

  // Paket-D: Wire the seven SQLx-backed organisation repositories and the
  // two aggregate services (`OrganizationPermissionService`,
  // `ProjectRequestService`) so the GraphQL resolvers in
  // `crate::graphql::organization` can run.
  let state = {
    let organization_repo: Arc<dyn myoxus_domain::repositories::OrganizationRepository> = Arc::new(
      myoxus_infrastructure::organization::PgOrganizationRepository::new(pool.clone()),
    );
    let organization_unit_type_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitTypeRepository> =
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitTypeRepository::new(pool.clone()));
    let organization_unit_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitRepository> = Arc::new(
      myoxus_infrastructure::organization::PgOrganizationUnitRepository::new(pool.clone()),
    );
    let organization_unit_member_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitMemberRepository> =
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitMemberRepository::new(pool.clone()));
    let organization_unit_workspace_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitWorkspaceRepository> =
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitWorkspaceRepository::new(pool.clone()));
    let organization_policy_repo: Arc<dyn myoxus_domain::repositories::OrganizationPolicyRepository> =
      Arc::new(myoxus_infrastructure::organization::PgOrganizationPolicyRepository::new(pool.clone()));
    let organization_project_request_repo: Arc<dyn myoxus_domain::repositories::OrganizationProjectRequestRepository> =
      Arc::new(myoxus_infrastructure::organization::PgOrganizationProjectRequestRepository::new(pool.clone()));
    let organization_unit_lifecycle_repo: Arc<dyn myoxus_domain::repositories::OrganizationUnitLifecycleRepository> =
      Arc::new(
        myoxus_infrastructure::organization::PgOrganizationUnitLifecycleRepository::new(
          pool.clone(),
          serde_json::to_value(&state.config.oauth.providers).unwrap_or_else(|_| serde_json::json!({})),
        ),
      );
    let organization_unit_lifecycle_service =
      Arc::new(myoxus_application::organization::OrganizationUnitLifecycleService::new(
        organization_unit_lifecycle_repo,
        state.audit_recorder().clone(),
      ));

    let (permission_service, project_request_service, import_export_service) = myoxus_api::organization::build_services(
      pool.clone(),
      organization_repo.clone(),
      organization_unit_type_repo.clone(),
      organization_unit_member_repo.clone(),
      organization_unit_repo.clone(),
      organization_unit_workspace_repo.clone(),
      organization_policy_repo.clone(),
      organization_project_request_repo.clone(),
    );

    info!("organization repositories and services wired");

    state
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
      .with_organization_permission_service(permission_service)
      .with_organization_project_request_service(project_request_service)
      .with_organization_import_export_service(import_export_service)
      .with_organization_unit_lifecycle_service(organization_unit_lifecycle_service)
      .with_oidc_group_directory(Arc::new(
        myoxus_infrastructure::organization::HttpOidcGroupDirectory::new(additional_ca.as_ref())?,
      ))
  };

  // P104-C: Attach DocCache tuning handles for runtime TTL overrides and auto-tuning.
  let state = if let Some(handles) = doc_cache_tuning_handles {
    state.with_doc_cache_tuning(handles)
  } else {
    state
  };
  state.set_startup_checks(startup_checks).await;
  info!("core dependency checks passed; continuing startup reconciliation");

  // Build the Redis queue and adapter.
  let redis_worker_queue = RedisQueue::from_client(
    queue_client.clone(),
    format!("bull:{}", queue_namespace.trim_end_matches(":queue")),
  );
  // Normal SQL startup already transferred pending native reminders. No queue
  // worker or replacement timing admission may start before retiring this scan.
  let retired_calendar_scans = redis_worker_queue.retire_calendar_reminder_enqueue_tick().await?;
  info!(retired_calendar_scans, "retired pending Calendar enqueue scans");
  let retired_database_scans = redis_worker_queue.retire_database_reminder_fire_tick().await?;
  let retired_git_ticks = redis_worker_queue.retire_git_sync_schedule_tick().await?;
  tracing::info!(retired_git_ticks, "retired native Git scheduling tick");
  info!(retired_database_scans, "retired pending Database reminder timing ticks");
  let mut registered_startup = myoxus_infrastructure::scheduling::registered_import::RegisteredStartup::acquire(
    &pool,
    queue_client,
    format!("bull:{}", queue_namespace.trim_end_matches(":queue")),
  )
  .await?;
  let imported = registered_startup.import_pending(chrono::Utc::now()).await?;
  info!(
    retained = imported.retained,
    deduplicated = imported.deduplicated,
    "registered native repeat slots transferred"
  );
  // Database background work and reminder delivery share the canonical Redis
  // queue. Wire the service only after this handle exists; reading it from
  // ApiState earlier would always observe the pre-queue construction state.
  let database_job_enqueuer: Arc<dyn myoxus_application::database::DatabaseJobEnqueuer> =
    Arc::new(RedisDatabaseJobEnqueuer::new(redis_worker_queue.clone()));
  let redis_queue_adapter: Arc<dyn WorkQueuePort> = Arc::new(RedisQueueAdapter {
    queue: redis_worker_queue.clone(),
  });
  template_service.set_reconcile_queue(redis_queue_adapter.clone())?;
  // Publication and delivery use the existing Registry scheduler once its Queue
  // is wired, still before workers or incoming traffic can consume the release.
  let document_registration = myoxus_application::feature_bundle::register_feature_document_sources(
    &template_service,
    &feature_sources.bundles,
    &feature_sources.resolved.active,
  )
  .await?;
  info!(
    registered_versions = document_registration.registered_versions,
    current = document_registration.selection.current.len(),
    operator_current_preserved = document_registration.selection.operator_current_preserved.len(),
    scheduled_workspaces = document_registration.scheduled_workspaces,
    "Feature document sources admitted through native Registry"
  );
  // PostgreSQL owns XWS state and Redis Queue carries content-free wake-ups.
  // The regular runtime supplies Queue, Cache, and Socket Redis roles. Cache
  // and Socket remain post-commit transports, so a transient transport failure
  // leaves the durable outbox pending instead of rolling publication back.
  let workspace_content_operation_repository = Arc::new(PgWorkspaceContentOperationRepository::new(
    pool.clone(),
    database_starter_catalog.clone(),
  ));
  let workspace_content_cluster_coordinator = Arc::new(WorkspaceContentClusterCoordinator::new(
    workspace_content_operation_repository.clone(),
    Arc::new(RedisWorkspaceContentQueueAdapter::new(redis_worker_queue.clone())),
    state
      .cache_bus()
      .cloned()
      .map(|port| port as Arc<dyn WorkspaceContentCacheInvalidationPort>),
    state
      .redis_ws_adapter()
      .cloned()
      .map(|port| port as Arc<dyn WorkspaceContentRealtimePort>),
  ));
  let cache_fanout = state.cache_bus().is_some();
  let realtime_fanout = state.redis_ws_adapter().is_some();
  if cache_fanout && realtime_fanout {
    info!("XWS durable queue recovery and Redis post-commit fanout wired");
  } else {
    warn!(
      cache_fanout,
      realtime_fanout, "XWS durable queue recovery wired with deferred post-commit fanout"
    );
  }
  let workspace_content_authorization_source = PgWorkspaceContentAuthorizationSource::new(pool.clone());
  let workspace_content_authorizer = Arc::new(WorkspaceContentAuthorizer::new(
    state.permission_service(),
    workspace_content_authorization_source.clone(),
  ));
  let workspace_content_control_service = Arc::new(WorkspaceContentControlService::new(
    workspace_content_operation_repository.clone(),
    workspace_content_operation_repository.clone(),
    workspace_content_operation_repository.clone(),
    workspace_content_operation_repository.clone(),
    Arc::new(
      PgWorkspaceContentGraphSource::new(pool.clone(), state.doc().clone()).with_git_capture(Arc::new(
        myoxus_api::git_sync_engine::extract_capture::ExtractGitCapture::new(state.clone()),
      )),
    ),
    workspace_content_authorizer,
    workspace_content_cluster_coordinator.clone(),
    workspace_content_operation_repository.clone(),
    state.storage().clone(),
    state.audit_recorder().clone(),
  ));
  let workspace_content_reference_repository = Arc::new(PgWorkspaceContentRedirectRepository::new(
    pool.clone(),
    state.doc().clone(),
  ));
  let workspace_content_redirect_service = Arc::new(WorkspaceContentRedirectService::new(
    workspace_content_reference_repository.clone(),
    state.permission_service(),
    state.doc().clone(),
  ));
  let state = state
    .with_workspace_content_cluster_coordinator(workspace_content_cluster_coordinator.clone())
    .with_workspace_content_control_service(workspace_content_control_service)
    .with_workspace_content_redirect_service(workspace_content_redirect_service);

  // PDF-Export V2: wire the ICC profile repository, font library repository
  // and a typed PDF blob store on top of the same opendal backend used by
  // general blob storage. All are mandatory for the admin `pdfIccProfiles*`
  // and `pdfFonts*` GraphQL surfaces; without them the resolvers reject calls
  // with a clear "not configured" error.
  let pdf_icc_repo: Arc<dyn myoxus_domain::repositories::PdfIccProfileRepository> = Arc::new(
    myoxus_infrastructure::pdf_export::PgPdfIccProfileRepository::new(pool.clone()),
  );
  let pdf_font_repo: Arc<dyn myoxus_domain::repositories::PdfFontRepository> = Arc::new(
    myoxus_infrastructure::pdf_export::PgPdfFontRepository::new(pool.clone()),
  );
  let pdf_blob_store = Arc::new(myoxus_infrastructure::pdf_export::PdfBlobStore::new(
    storage_operator.clone(),
  ));
  // Workspace-scoped PDF surfaces need the template registry, the
  // per-workspace assignment table, and the split document-branding/PDF
  // settings adapter. All three are mandatory for `availablePdfTemplates`,
  // `documentBrandingProfile` and `pdfExportSettings`.
  let pdf_template_repo: Arc<dyn myoxus_domain::repositories::PdfTemplateRepository> = Arc::new(
    myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(pool.clone()),
  );
  let pdf_assignment_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository> =
    Arc::new(myoxus_infrastructure::pdf_export::PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone()));
  let pdf_brand_repo: Arc<dyn myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository> =
    Arc::new(myoxus_infrastructure::pdf_export::PgPdfWorkspaceBrandAssetRepository::new(pool.clone()));
  // P-PDF-TPL-AUDIT-01: render-audit repo. Required in production so the
  // synchronous "render only with audit" guarantee holds — without it the
  // mutation logs a `warn!` and proceeds (legacy / test paths).
  let pdf_render_audit_repo: Arc<dyn myoxus_domain::repositories::PdfExportRenderAuditRepository> =
    Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportRenderAuditRepository::new(pool.clone()));
  // P-DOC-VER-02: workspace-facing document-version picker/settings need the
  // label rows and per-doc opt-in settings wired before GraphQL starts.
  let document_version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository> =
    Arc::new(myoxus_infrastructure::document_version::PgDocumentVersionRepository::new(pool.clone()));
  let document_version_config = state.config_overrides.clone();
  let capture_enabled = config.doc.history.enabled;
  let capture_interval = i64::try_from(config.doc.history.interval).unwrap_or(i64::MAX);
  let document_version_config_reader: myoxus_infrastructure::document_version::ConfigValuesReader =
    Arc::new(move || {
      let config = document_version_config.clone();
      Box::pin(async move {
        let mut values = config.read().await.overrides.clone();
        values
          .entry("doc.history.enabled".into())
          .or_insert(serde_json::json!(capture_enabled));
        values
          .entry("doc.history.interval".into())
          .or_insert(serde_json::json!(capture_interval));
        values
      })
    });
  let document_version_settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository> =
    Arc::new(
      myoxus_infrastructure::document_version::PgDocumentVersioningSettingsRepository::new(pool.clone())
        .with_config_values_reader(document_version_config_reader.clone()),
    );
  let document_edit_capture_service = myoxus_application::document_version::DocumentEditCaptureService::new(Arc::new(
    myoxus_infrastructure::document_version::PgDocumentEditCaptureRepository::new(pool.clone())
      .with_field_capture_default_locale(config.i18n.default_locale.clone()),
  ));
  let document_metadata_policy_repo: Arc<dyn myoxus_domain::repositories::DocumentMetadataPolicyRepository> =
    Arc::new(myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository::new(pool.clone()));
  let mut document_metadata_policy_service =
    myoxus_application::document_metadata_policy::DocumentMetadataPolicyService::new(
      document_metadata_policy_repo.clone(),
    );
  if let Some(cache) = doc_metadata_projection_cache.clone() {
    document_metadata_policy_service = document_metadata_policy_service.with_index_cache(cache);
  }
  let document_metadata_repo =
    Arc::new(myoxus_infrastructure::document_metadata::PgDocumentMetadataRepository::new(pool.clone()));
  let mut document_metadata_service =
    myoxus_application::document_metadata::DocumentMetadataService::new(document_metadata_repo.clone());
  if let Some(cache) = doc_metadata_projection_cache.clone() {
    document_metadata_service = document_metadata_service.with_projection_cache(cache);
  }
  let document_graph_repo: Arc<dyn myoxus_domain::repositories::DocumentGraphRepository> = Arc::new(
    myoxus_infrastructure::document_graph::PgDocumentGraphRepository::new(pool.clone()),
  );
  let document_graph_limits = DocumentGraphLimits {
    max_graph_nodes: config.document_graph.max_graph_nodes,
    max_graph_edges: config.document_graph.max_graph_edges,
    max_occurrences_per_edge: config.document_graph.max_occurrences_per_edge,
    max_reindex_batch: config.document_graph.max_reindex_batch,
    max_catch_up_workspaces: config.document_graph.max_catch_up_workspaces,
    preview_max_chars: config.document_graph.preview_max_chars,
    stale_after_seconds: config.document_graph.stale_after_seconds,
    enqueue_delay_ms: config.document_graph.enqueue_delay_ms,
    max_reindex_attempts: config.document_graph.max_reindex_attempts,
  };
  let document_graph_service = Arc::new(DocumentGraphService::new(
    document_graph_repo,
    Arc::new(state.doc().clone()),
    state.permission_service(),
    Arc::new(document_metadata_service.clone()),
    Some(database_repo.clone()),
    Some(database_repo.clone()),
    Some(redis_queue_adapter.clone()),
    document_graph_limits,
  ));
  state
    .doc()
    .set_document_graph_index_hook(document_graph_service.clone())
    .await;

  // Construct the Database subsystem only after every production collaborator
  // exists. No request can observe a service with late or partial wiring.
  let database_effects = DatabaseMutationEffects::new(
    state
      .database_activity_recorder()
      .unwrap_or_else(myoxus_application::database::activity::DatabaseActivityRecorder::noop),
    Arc::new(state.audit_recorder().clone()),
    notification_service_for_db,
    database_change_notifications,
  );
  let mut database_dependencies = DatabaseServiceDependencies::disabled()
    .with_effects(database_effects.clone())
    .with_blob_service(state.blob_service())
    .with_template_registry(template_service.clone())
    .with_job_queue(database_job_enqueuer)
    .with_workspace_tags(workspace_tag_service);
  if let Some(cache) = doc_metadata_projection_cache {
    database_dependencies = database_dependencies.with_page_inventory_cache(cache);
  }
  let database_services = Arc::new(DatabaseServices::new(
    database_repo.clone(),
    database_doc_service,
    database_permission_service,
    database_limits.clone(),
    workspace_store.clone(),
    database_starter_catalog.clone(),
    database_dependencies,
  ));

  // Catalog admission precedes this per-Database pass. A failed instance must
  // not prevent unrelated workspaces from serving their ready Task containers.
  let managed_report = database_services.definition.initialize_managed_databases().await?;
  info!(
    ready = managed_report.ready,
    unavailable = managed_report.unavailable,
    defaults_ensured = managed_report.defaults_ensured,
    "managed Database startup pass completed"
  );
  for (database_id, reason) in managed_report.failures {
    warn!(%database_id, reason_code = %reason, "managed Database remains unavailable");
  }
  let mut assistant_packages = myoxus_application::workspace::assistant_packages::AssistantPackageService::new(
    assistant_package_catalog,
    database_starter_catalog.clone(),
    database_services.definition.clone(),
    database_services.views.clone(),
    workspace_store.clone(),
    state.config.i18n.default_currency.clone(),
    state.config.i18n.default_locale.clone(),
  )
  .with_context_workflows_enabled(config.workspace_automation.enabled);
  if let Some(documents) = state.document_template_service() {
    assistant_packages = assistant_packages.with_project_placement(documents.clone());
    if let Some(registry) = state.template_registry() {
      assistant_packages = assistant_packages.with_document_components(documents, Arc::new(registry.clone()));
    }
  }
  let assistant_packages = Arc::new(assistant_packages);
  let workspace_automation_repo: Arc<dyn myoxus_domain::repositories::WorkspaceAutomationRepository> = Arc::new(
    myoxus_infrastructure::workspace_automation::PgWorkspaceAutomationRepository::new(pool.clone())
      .with_database_templates(database_starter_catalog.clone()),
  );
  let workspace_automation_webhook = Arc::new(
    myoxus_infrastructure::workspace_automation::ReqwestWorkspaceAutomationWebhookClient::new(
      state.http_client().clone(),
    ),
  );
  let workspace_automation_service = WorkspaceAutomationService::new(
    workspace_automation_repo,
    database_repo.clone(),
    database_repo.clone(),
    state.doc().clone(),
    state.permission_service(),
    state.audit_recorder().clone(),
    Some(redis_queue_adapter.clone()),
    Some(workspace_automation_webhook),
    WorkspaceAutomationLimits {
      enabled: config.workspace_automation.enabled,
      max_actions_per_run: config.workspace_automation.max_actions_per_run,
      max_runs_per_minute: config.workspace_automation.max_runs_per_minute,
      webhook_timeout_seconds: config.workspace_automation.webhook_timeout_seconds,
      max_retry_attempts: config.workspace_automation.max_retry_attempts,
    },
    database_services.editing.clone(),
  )
  .with_context_documents(
    workspace_store.clone(),
    assistant_packages.clone(),
    Arc::new(state.auth().clone()),
  );
  let workspace_automation_runtime = Arc::new(
    myoxus_infrastructure::workflow_runtime::GlirulusWorkspaceAutomationRuntime::new(
      pool.clone(),
      workspace_automation_service.native_executor(),
    )
    .with_database_templates(database_starter_catalog.clone())
    .with_optional_automations_enabled(config.workspace_automation.enabled),
  );
  workspace_automation_runtime.readiness().await?;
  let workspace_automation_service =
    Arc::new(workspace_automation_service.with_runtime(workspace_automation_runtime.clone()));
  let task_recurrence = Arc::new(myoxus_application::recurrence::TaskRecurrenceService::new(
    Arc::new(myoxus_infrastructure::recurrence::PgTaskRecurrenceRepository::new(
      pool.clone(),
      database_repo.clone(),
    )),
    database_services.editing.clone(),
  ));
  document_metadata_service = document_metadata_service.with_review_planning(
    myoxus_application::document_metadata::review::ReviewPlanningCapabilities {
      repo: document_metadata_repo,
      packages: assistant_packages.clone(),
      automations: workspace_automation_service.clone(),
      auth: Arc::new(state.auth().clone()),
      defaults: myoxus_application::auth::UserPreferenceDefaults {
        locale: config.i18n.default_locale.clone(),
        ..Default::default()
      },
    },
  );
  let scheduling = Arc::new(
    myoxus_infrastructure::scheduling::PgSchedulingRepository::new(pool.clone(), workspace_automation_runtime.clone())
      .with_task_source(task_recurrence.clone())
      .with_database_reminders(database_repo.clone(), database_effects)
      .with_git_rotation_providers(git_token_rotation_service.available_providers())
      .with_git_policy(Arc::new(
        myoxus_api::git_sync_engine::scheduler::SharedGitPolicySource::new(state.clone()),
      ))
      .with_document_review_source(Arc::new(document_metadata_service.clone())),
  );
  let state = state
    .with_database_services(database_services.clone())
    .with_task_recurrence_service(task_recurrence)
    .with_assistant_packages(assistant_packages);

  let workspace_import_repository: Arc<dyn myoxus_application::workspace_import::WorkspaceImportRepository> =
    Arc::new(myoxus_infrastructure::workspace_import::PgWorkspaceImportRepository::new(pool.clone()));
  let workspace_export_service = Arc::new(myoxus_application::workspace_export::ObsidianVaultExportService::new(
    state.permission_service(),
    workspace_store.clone(),
    state.doc().clone(),
    Arc::new(document_metadata_service.clone()),
    workspace_tag_repo,
    state.blob_service(),
    Arc::new(myoxus_infrastructure::workspace_import::PgWorkspaceImportRepository::new(pool.clone())),
  ));
  let workspace_import_policy: Arc<dyn myoxus_application::workspace_import::WorkspaceImportPolicyProvider> = Arc::new(
    myoxus_api::workspace_import::ApiWorkspaceImportPolicyProvider::new(config.clone(), state.config_overrides.clone()),
  );
  let workspace_import_service = Arc::new(myoxus_application::workspace_import::WorkspaceImportService::new(
    workspace_import_repository,
    state.storage().clone(),
    state.blob_service(),
    workspace_store,
    state.doc().clone(),
    database_services.import_export.clone(),
    redis_queue_adapter.clone(),
    workspace_import_policy,
  ));
  workspace_import_service.set_metrics_service(state.metrics_arc());

  let state = state
    .with_redis_queue(redis_worker_queue.clone())
    .with_pdf_icc_repo(pdf_icc_repo.clone())
    .with_pdf_font_repo(pdf_font_repo.clone())
    .with_pdf_blob_store(pdf_blob_store.clone())
    .with_pdf_template_repo(pdf_template_repo.clone())
    .with_pdf_assignment_repo(pdf_assignment_repo)
    .with_pdf_brand_repo(pdf_brand_repo)
    .with_pdf_render_audit_repo(pdf_render_audit_repo)
    .with_document_version_repo(document_version_repo.clone())
    .with_document_version_settings_repo(document_version_settings_repo.clone())
    .with_document_metadata_policy_repo(document_metadata_policy_repo)
    .with_document_metadata_policy_service(document_metadata_policy_service)
    .with_document_graph_service(document_graph_service.clone())
    .with_workspace_automation_service(workspace_automation_service.clone())
    .with_workspace_import_service(workspace_import_service.clone())
    .with_workspace_export_service(workspace_export_service)
    .with_document_metadata_service(document_metadata_service);

  // Capture the fully wired field owners without an indexer self-reference.
  // The cloned state still shares live formatting overrides and repositories.
  let search_indexer = Arc::new(
    SearchIndexerService::new(
      redis_queue_adapter.clone(),
      search_repository,
      Arc::new(state.doc().clone()),
    )
    .with_field_source(Arc::new(state.clone())),
  );
  let state = state.with_search_indexer(search_indexer.clone());

  if let Err(error) = state.validate_production_composition() {
    error!(
      missing_capabilities = ?error.missing_capabilities(),
      "production API composition is incomplete; aborting before workers start"
    );
    return Err(error.into());
  }

  // P-PDF-TPL-COLOR-01-06: idempotently seed all bundled RGB/CMYK system ICC
  // profiles so every fresh deployment ships with the full built-in color
  // palette. Failures are logged and swallowed — admins can always upload
  // profiles manually if a seed slips through.
  match myoxus_infrastructure::pdf_export::seed_system_icc_profiles(pdf_icc_repo, pdf_blob_store.clone()).await {
    Ok(0) => debug!("P-PDF-TPL-COLOR-01-06: bundled ICC profiles already present"),
    Ok(n) => info!(inserted = n, "P-PDF-TPL-COLOR-01-06: bundled ICC profiles seeded"),
    Err(e) => warn!(error = %e, "P-PDF-TPL-COLOR-01-06: failed to seed bundled ICC profiles (non-fatal)"),
  }

  // PDF templates are executable renderer inputs. Reconcile the binary-owned
  // bundles and reject an incompatible active catalog before accepting HTTP
  // traffic; deferring this error would make exports fail nondeterministically.
  let reconciled = myoxus_infrastructure::pdf_export::seed_system_pdf_templates(
    pdf_template_repo.clone(),
    pdf_blob_store.clone(),
    &template_root.join("pdf"),
    config.pdf_export.max_template_bytes(),
    std::time::Duration::from_secs(config.pdf_export.limits.render_timeout_seconds),
  )
  .await
  .map_err(|error| format!("failed to reconcile bundled PDF templates: {error}"))?;
  if reconciled == 0 {
    debug!("bundled PDF templates already present");
  } else {
    info!(changed = reconciled, "bundled PDF templates reconciled");
  }
  myoxus_infrastructure::pdf_export::verify_active_pdf_template_engines(&pool)
    .await
    .map_err(|error| format!("PDF template engine compatibility check failed: {error}"))?;
  match myoxus_infrastructure::pdf_export::ensure_default_pdf_template_assignments(&pool).await {
    Ok(0) => debug!("all active workspaces already have the default PDF template assigned"),
    Ok(n) => info!(assigned = n, "assigned the default PDF template to existing workspaces"),
    Err(e) => warn!(error = %e, "failed to repair default PDF template workspace assignments"),
  }

  // P84-H-19: Cache warmup pre-populates retained query caches before the
  // server starts accepting requests. Failures remain non-fatal.

  // If canonical search content is empty but active docs exist, enqueue a
  // full reindex so first boot cannot leave search permanently empty.
  match check_search_content_first_boot(&pool).await {
    Ok(true) => {
      info!("search_content is empty, triggering first-boot full reindex");
      match search_indexer.start_full_reindex(None, 50).await {
        Ok(run_id) => info!(%run_id, "first-boot search reindex enqueued"),
        Err(e) => warn!(error = %e, "failed to enqueue first-boot search reindex (non-fatal)"),
      }
    }
    Ok(false) => {
      debug!("search_content first-boot check passed, no reindex needed");
    }
    Err(e) => {
      warn!(error = %e, "search_content first-boot check failed (non-fatal)");
    }
  }

  let calendar_dispatcher = Arc::new(
    CalendarReminderDispatcher::new(calendar_repository.clone(), store.clone())
      .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
        locale: config.i18n.default_locale.clone(),
        ..Default::default()
      })
      .with_notification_service(Arc::new(state.notification().clone()))
      .with_mailer(mailer.clone())
      .with_socket_port(Arc::new(SocketReminderPort(state.redis_ws_adapter().cloned()))),
  );
  let (shutdown_tx, shutdown_rx) = watch::channel(false);

  // Redis-based WorkerRuntime for BullMQ-compatible queues. Workers receive
  // one startup-materialized snapshot because all `job.*` descriptors are
  // explicitly restart-bound in the canonical registry.
  let initial_job_config = JobConfigSnapshot {
    max_attempts: config.job.queue.attempts as i32,
    poll_timeout_seconds: config.job.worker.poll_timeout_seconds,
    remove_on_complete: config.job.queue.remove_on_complete,
    remove_on_fail_age_seconds: config.job.queue.remove_on_fail.age,
    remove_on_fail_count: config.job.queue.remove_on_fail.count,
    ..JobConfigSnapshot::default()
  };
  let (_job_config_tx, job_config_rx) = watch::channel(initial_job_config);
  let global_runtime_config = RuntimeConfig {
    poll_timeout_seconds: config.job.worker.poll_timeout_seconds,
    ..RuntimeConfig::default()
  };
  let mut redis_worker_runtime =
    WorkerRuntime::new(redis_worker_queue.clone(), global_runtime_config, shutdown_rx.clone())
      .with_config_watch(job_config_rx);

  // Notification queue: processes sendInvitation, sendComment, sendMail, etc.
  let notification_service_for_worker = Arc::new(state.notification().clone());
  redis_worker_runtime.register(
    NotificationQueueHandler {
      database_repository: database_repo.clone(),
      calendar_mail_dispatcher,
      notification_service: notification_service_for_worker,
      notification_adapter: state.redis_ws_adapter().cloned(),
      mail: mailer.clone(),
      auth_store: state.auth().store.clone(),
      state: state.clone(),
      database_pool: pool.clone(),
      database_reminders: state.database_services().map(|services| services.reminders.clone()),
    },
    QueueConfig {
      concurrency: config.job.queues.notification.concurrency as usize,
      max_attempts: 3,
      ..Default::default()
    },
  );

  // Doc queue: mergePendingDocUpdates, findEmptySummaryDocs, etc.
  let doc_service_for_worker = state.doc().clone();
  redis_worker_runtime.register(
    DocQueueHandler {
      doc_service: Arc::new(doc_service_for_worker),
      queue: redis_worker_queue.clone(),
      edit_capture_service: document_edit_capture_service.clone(),
      config: Arc::new(config.clone()),
      config_overrides: state.config_overrides.clone(),
    },
    QueueConfig {
      concurrency: config.job.queues.doc.concurrency as usize,
      max_attempts: 5,
      ..Default::default()
    },
  );

  // Git-Sync runners and maintenance share the same process-local exclusion;
  // Redis remains the first, distributed ownership layer.
  let git_sync_locks = myoxus_api::git_sync_engine::locking::new_locks();

  // Nightly cleanup queue.
  redis_worker_runtime.register(
    NightlyQueueHandler {
      pool: pool.clone(),
      config: Arc::new(config.clone()),
      config_overrides: state.config_overrides.clone(),
      blob_storage: state.storage().clone(),
      doc_service: Arc::new(state.doc().clone()),
      document_version_repo: document_version_repo.clone(),
      document_version_settings_repo: document_version_settings_repo.clone(),
      audit_recorder: state.audit_recorder().clone(),
      workspace_import_service: workspace_import_service.clone(),
      pdf_export_cleanup: Arc::new(myoxus_application::pdf_export::cleanup::PdfExportCleanupService::new(
        state.pdf_export_jobs(),
        blob_store.clone(),
        state.storage().clone(),
      )),
      retention: myoxus_application::maintenance::RetentionService::new(Arc::new(
        myoxus_infrastructure::maintenance::SqlxRetentionRepository::new(pool.clone()),
      )),
      blob_maintenance: blob_store.clone(),
      copilot_service: state.copilot(),
      git_sync_locks: git_sync_locks.clone(),
      git_sync_lock_redis: lock_redis.clone(),
    },
    QueueConfig {
      concurrency: config.job.queues.nightly.concurrency as usize,
      max_attempts: 3,
      ..Default::default()
    },
  );

  // Workspace queue: blob cleanup after workspace deletion (P100-SRV-A).
  redis_worker_runtime.register(
    WorkspaceQueueHandler {
      blob_storage: state.storage().clone(),
      blob_maintenance: blob_store.clone(),
    },
    QueueConfig {
      concurrency: 2,
      max_attempts: 3,
      ..Default::default()
    },
  );

  // Telemetry queue (P-Telemetry-C): processes flush/rollup/retention jobs.
  // Concurrency = 1 because flush drains a shared hot buffer and the
  // repository serializes rollup/retention across instances.
  redis_worker_runtime.register(
    myoxus_api::telemetry_worker::TelemetryQueueHandler {
      service: state.telemetry_arc(),
      flush_batch_max: config.telemetry.batch_max_events,
      retention_raw_days: config.telemetry.retention_raw_days,
      retention_daily_days: config.telemetry.retention_daily_days,
    },
    QueueConfig {
      concurrency: 1,
      max_attempts: 3,
      ..Default::default()
    },
  );

  // Metrics queue (P-Metrics-D): business-metrics flush/rollup/retention.
  // Concurrency 1 — shared recorder snapshot + advisory-locked rollup/retention.
  redis_worker_runtime.register(
    myoxus_api::metrics_worker::MetricsQueueHandler {
      service: state.metrics_arc(),
      pool: pool.clone(),
      persistence_enabled: config.metrics.persistence_enabled,
      retention_raw_days: config.metrics.retention_raw_days,
      retention_daily_days: config.metrics.retention_daily_days,
    },
    QueueConfig {
      concurrency: 1,
      max_attempts: 3,
      ..Default::default()
    },
  );

  // Copilot queue: title generation, embedding jobs, session cleanup.
  let copilot_service_for_worker = state.copilot();
  let (copilot_provider_registry, copilot_default_model) = build_llm_provider_registry(&config);
  let embedding_repo =
    Arc::new(myoxus_infrastructure::copilot::embedding_store::SqlxCopilotEmbeddingRepository::new(pool.clone()));
  redis_worker_runtime.register(
    CopilotQueueHandler {
      copilot_service: copilot_service_for_worker,
      provider_registry: copilot_provider_registry,
      transcription_state: state.clone(),
      copilot_config: config.copilot.clone(),
      default_model: copilot_default_model,
      queue: redis_worker_queue.clone(),
      embedding_repo,
      doc_service: Arc::new(state.doc().clone()),
      blob_service: state.blob_service(),
    },
    QueueConfig {
      concurrency: config.job.queues.copilot.concurrency as usize,
      max_attempts: 5,
      ..Default::default()
    },
  );

  // Indexer queue: routes indexDoc / autoIndexWorkspaces to SearchIndexerService.
  redis_worker_runtime.register(
    IndexerQueueHandler {
      search_indexer: search_indexer.clone(),
    },
    QueueConfig {
      concurrency: config.job.queues.indexer.concurrency as usize,
      max_attempts: 8,
      ..Default::default()
    },
  );

  redis_worker_runtime.register(
    myoxus_api::document_graph_worker::DocumentGraphQueueHandler::new(document_graph_service.clone()),
    QueueConfig {
      concurrency: config.job.queues.document_graph.concurrency as usize,
      max_attempts: config.document_graph.max_reindex_attempts.max(1),
      ..Default::default()
    },
  );

  if let Some(database_services) = state.database_services() {
    redis_worker_runtime.register(
      myoxus_api::database_worker::DatabaseQueueHandler::new(
        database_services.projection.clone(),
        database_services.import_export.clone(),
      ),
      QueueConfig {
        concurrency: config.job.queues.database.concurrency as usize,
        max_attempts: 3,
        ..Default::default()
      },
    );
  }

  redis_worker_runtime.register(
    myoxus_api::workspace_import::WorkspaceImportQueueHandler::new(workspace_import_service.clone()),
    QueueConfig {
      concurrency: config.workspace.r#import.worker_concurrency.max(1),
      max_attempts: 3,
      ..Default::default()
    },
  );

  let workspace_content_worker =
    WorkspaceContentWorkerService::new(workspace_content_operation_repository.clone(), instance_id)
      .with_queue(Arc::new(RedisWorkspaceContentQueueAdapter::new(
        redis_worker_queue.clone(),
      )))
      .with_git_metadata_executor(Arc::new(
        myoxus_api::git_sync_engine::extract_metadata::ExtractGitMetadata::new(
          state.clone(),
          workspace_content_operation_repository.clone(),
          git_sync_locks.clone(),
        ),
      ));
  let link_service = WorkspaceContentLinkService::new(state.doc().clone(), state.permission_service())
    .with_database_definition(state.database_services().map(|services| services.definition.clone()))
    .with_workspace_tag_service(state.workspace_tag_service());
  let workspace_content_worker = workspace_content_worker.with_semantic_executor(
    WorkspaceContentOperationKind::Link,
    Arc::new(WorkspaceContentLinkExecutor::new(
      workspace_content_operation_repository.clone(),
      workspace_content_operation_repository.clone(),
      link_service,
      workspace_content_operation_repository.clone(),
      instance_id,
    )),
  );
  let workspace_content_worker =
    if let (Some(document_metadata_service), Some(database_services), Some(workspace_tag_service)) = (
      state.document_metadata_service(),
      state.database_services(),
      state.workspace_tag_service(),
    ) {
      let copy_source = Arc::new(
        WorkspaceContentCopySourceService::new(
          state.doc().clone(),
          state.blob_service(),
          state.permission_service(),
          document_metadata_service,
        )
        .with_workspace_tags(workspace_tag_service.clone())
        .with_reference_repository(workspace_content_reference_repository.clone()),
      );
      let reconcile_source = Arc::new(WorkspaceContentReconcileSourceService::new(
        Some(database_services.definition.clone()),
        Some(database_services.import_export.clone()),
        Some(workspace_tag_service),
      ));
      let organizer_stage = Arc::new(WorkspaceContentOrganizerStageExecutor::new(
        workspace_content_operation_repository.clone(),
        workspace_content_operation_repository.clone(),
        state.doc().clone(),
        state.permission_service(),
        state.storage().clone(),
        workspace_content_reference_repository.clone(),
      ));
      let publication = Arc::new(
        WorkspaceContentCopyPublicationService::new(
          workspace_content_operation_repository.clone(),
          workspace_content_operation_repository.clone(),
          reconcile_source.clone(),
          state.storage().clone(),
          Arc::new(
            PgWorkspaceContentCopyPublicationRepository::new(
              pool.clone(),
              state.storage().clone(),
              database_starter_catalog.clone(),
            )
            .with_quota_config(default_ws_quota_mb),
          ),
        )
        .with_databases(database_services.import_export.clone())
        .with_organizer(
          organizer_stage,
          Arc::new(WorkspaceContentOrganizerRevisionService::new(state.doc().clone())),
        ),
      );
      let workspace_content_worker = workspace_content_worker.with_semantic_executor(
        WorkspaceContentOperationKind::Copy,
        Arc::new(
          WorkspaceContentCopyExecutor::new(
            workspace_content_operation_repository.clone(),
            workspace_content_operation_repository.clone(),
            copy_source,
            state.storage().clone(),
          )
          .with_reconciler(Arc::new(WorkspaceContentReconcileExecutor::new(
            workspace_content_operation_repository.clone(),
            workspace_content_operation_repository.clone(),
            reconcile_source,
            state.storage().clone(),
          )))
          .with_publication(publication, instance_id.to_string()),
        ),
      );
      let transfer_publication = Arc::new(
        WorkspaceContentMovePublicationService::new(
          workspace_content_operation_repository.clone(),
          workspace_content_operation_repository.clone(),
          state.permission_service(),
          workspace_content_operation_repository.clone(),
          workspace_content_operation_repository.clone(),
          state.doc().clone(),
          Arc::new(
            PgWorkspaceContentMovePublicationRepository::new(
              pool.clone(),
              state.storage().clone(),
              database_starter_catalog.clone(),
            )
            .with_config_values_reader(document_version_config_reader.clone())
            .with_quota_config(default_ws_quota_mb),
          ),
          instance_id.to_string(),
        )
        .with_extract(workspace_content_operation_repository.clone(), state.storage().clone()),
      );
      workspace_content_worker
        .with_semantic_executor(WorkspaceContentOperationKind::Move, transfer_publication.clone())
        .with_semantic_executor(WorkspaceContentOperationKind::ExtractFolder, transfer_publication)
        .with_recovery_handler(
          WorkspaceContentOperationKind::ExtractFolder,
          Arc::new(WorkspaceContentExtractRecoveryService::new(
            workspace_content_operation_repository.clone(),
            workspace_content_operation_repository.clone(),
            state.storage().clone(),
            instance_id.to_string(),
          )),
        )
    } else {
      // Copy and Move remain queued for a correctly configured worker; claiming
      // either without every canonical publication dependency would permit loss.
      workspace_content_worker
    };
  redis_worker_runtime.register(
    myoxus_api::workspace_content_worker::WorkspaceContentQueueHandler::new(Arc::new(workspace_content_worker))
      .with_audit_recorder(state.audit_recorder().clone()),
    QueueConfig {
      concurrency: config.job.queues.workspace_content_operation.concurrency as usize,
      max_attempts: 3,
      ..Default::default()
    },
  );

  if let Some(workspace_automation_service) = state.workspace_automation_service() {
    redis_worker_runtime.register(
      myoxus_api::workspace_automation_worker::WorkspaceAutomationQueueHandler::new(workspace_automation_service),
      QueueConfig {
        concurrency: config.job.queues.workspace_automation.concurrency as usize,
        max_attempts: 5,
        ..Default::default()
      },
    );
  }

  // Calendar reminder queue: processes and enqueues calendar reminders,
  // and retries deferred write-back operations (P90-CAL-F-05).
  let calendar_service_for_worker = Arc::new(CalendarService::new(calendar_repository.clone()));
  redis_worker_runtime.register(
    CalendarQueueHandler {
      dispatcher: calendar_dispatcher.clone(),
      calendar_service: calendar_service_for_worker,
    },
    QueueConfig {
      concurrency: config.job.queues.calendar_reminder.concurrency as usize,
      max_attempts: 8,
      ..Default::default()
    },
  );

  // CalDAV sync queue: pulls events from remote CalDAV servers and upserts locally.
  {
    use myoxus_infrastructure::caldav::sync::{CalDavSyncService, PlaintextCredentialDecryptor};
    let caldav_sync_svc = Arc::new(CalDavSyncService::new(
      Arc::new(myoxus_infrastructure::calendar::SqlxCalendarRepository::new(
        pool.clone(),
      )),
      Arc::new(PlaintextCredentialDecryptor),
      lock_redis.clone(),
      7,  // lookback_days
      90, // lookahead_days
      config.additional_ca.clone(),
    ));
    redis_worker_runtime.register(
      CalDavSyncQueueHandler { svc: caldav_sync_svc },
      QueueConfig {
        concurrency: config.job.queues.caldav_sync.concurrency as usize,
        max_attempts: 3,
        ..Default::default()
      },
    );
  }

  // Google Calendar sync queue: pulls events from Google Calendar API and upserts locally.
  // Only registered when Google OAuth credentials are configured.
  if let Some((google_client_id, google_client_secret)) = config.oauth.built_in_provider_credentials("google") {
    let google_client_id = google_client_id.to_string();
    let google_client_secret = google_client_secret.to_string();
    use myoxus_infrastructure::caldav::sync::PlaintextCredentialDecryptor as GcalDecryptor;
    use myoxus_infrastructure::google_calendar::{GoogleCalendarSyncService, GoogleChannelRenewalService};
    let gcal_repo = Arc::new(myoxus_infrastructure::calendar::SqlxCalendarRepository::new(
      pool.clone(),
    ));
    let gcal_sync_svc = Arc::new(GoogleCalendarSyncService::new(
      gcal_repo.clone(),
      Arc::new(GcalDecryptor),
      lock_redis.clone(),
      google_client_id.clone(),
      google_client_secret.clone(),
      7,  // lookback_days
      90, // lookahead_days
      config.additional_ca.clone(),
    ));
    // Build the channel renewal service only when a webhook base URL is set.
    let gcal_renewal_svc = config
      .calendar
      .google_webhook
      .webhook_base_url
      .as_ref()
      .map(|base_url| {
        Arc::new(
          GoogleChannelRenewalService::new(
            gcal_repo,
            Arc::new(GcalDecryptor),
            google_client_id,
            google_client_secret,
            base_url.clone(),
            config.additional_ca.clone(),
          )
          .with_webhook_secret(config.calendar.google_webhook.token.clone()),
        )
      });
    redis_worker_runtime.register(
      GoogleCalendarSyncQueueHandler {
        svc: gcal_sync_svc,
        renewal_svc: gcal_renewal_svc,
      },
      QueueConfig {
        concurrency: config.job.queues.google_calendar_sync.concurrency as usize,
        max_attempts: 3,
        ..Default::default()
      },
    );
    info!("google-calendar-sync queue handler registered");
  } else {
    info!("google-calendar-sync queue handler skipped (no Google OAuth credentials configured)");
  }

  // Git Sync queue: runs sync jobs triggered by triggerGitSync or polling.
  let git_sync_runner_config = myoxus_api::git_sync_engine::runner::RunnerConfig {
    overview_service: state.workspace_overview_service(),
    repo_base_dir: std::path::PathBuf::from(&config.git_sync.repo_base_dir),
    server_origin: config.server.origin.clone(),
    static_policy: config.git_sync.clone(),
    config_overrides: state.config_overrides.clone(),
    crypto_key: config.crypto.private_key.clone(),
    network_timeout_secs: config.git_sync.network_timeout_secs,
    local_timeout_secs: config.git_sync.local_timeout_secs,
    max_docs_per_sync: config.git_sync.max_docs_per_sync,
    clone_depth: config.git_sync.clone_depth,
    push_max_retries: config.git_sync.push_max_retries,
    commit_author_name: config.git_sync.commit_author_name.clone(),
    commit_author_email: config.git_sync.commit_author_email.clone(),
    parallel_conversion_threshold: config.git_sync.parallel_conversion_threshold,
    max_mirror_storage_mb: config.git_sync.max_mirror_storage_mb,
    min_free_disk_mb: config.git_sync.min_free_disk_mb,
    lock_ttl_seconds: config.git_sync.lock_ttl_seconds,
    lock_redis: lock_redis.clone(),
    cache_redis: cache_adapter
      .as_ref()
      .map(|adapter| adapter.clone() as Arc<dyn RedisPort>)
      .unwrap_or_else(|| state.redis_port()),
    redis_namespace: config.redis.namespace.clone(),
    mime_allowlist_admin: config.git_sync.mime_allowlist_admin.clone(),
    mime_blocklist_admin: config.git_sync.mime_blocklist_admin.clone(),
    mime_validation_mode: config.git_sync.mime_validation_mode.clone(),
  };
  myoxus_api::git_sync_engine::runner::reconcile_stale_running_runs(
    &pool,
    &git_sync_runner_config,
    state.storage().as_ref(),
  )
  .await;
  {
    let reconciliation_pool = pool.clone();
    let reconciliation_config = git_sync_runner_config.clone();
    let reconciliation_storage = state.storage().clone();
    tokio::spawn(async move {
      let interval_seconds = reconciliation_config
        .lock_ttl_seconds
        .max(reconciliation_config.network_timeout_secs)
        .max(60);
      let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
      interval.tick().await;
      loop {
        interval.tick().await;
        myoxus_api::git_sync_engine::runner::reconcile_stale_running_runs(
          &reconciliation_pool,
          &reconciliation_config,
          reconciliation_storage.as_ref(),
        )
        .await;
      }
    });
  }
  redis_worker_runtime.register(
    GitSyncQueueHandler {
      pool: pool.clone(),
      runner_config: git_sync_runner_config.clone(),
      locks: git_sync_locks,
      blob_storage: state.storage().clone(),
      token_rotation: git_token_rotation_service,
    },
    QueueConfig {
      concurrency: config.job.queues.git_sync.concurrency as usize,
      max_attempts: 3,
      // QUEUE-ROB-03: Git-sync jobs can take minutes (clone/push), so use a
      // longer stall threshold to avoid false stall detection.
      stall_interval_ms: config.git_sync.network_timeout_secs * 1000 + 30_000,
      ..Default::default()
    },
  );

  // Template Registry queue: always registered so it can be enabled at
  // runtime via admin settings.  The handler checks the enabled flag
  // before processing each job.
  redis_worker_runtime.register(
    TemplateRegistryQueueHandler {
      registry: template_service.clone(),
      pool: pool.clone(),
      queue: redis_worker_queue.clone(),
      config_overrides: state.config_overrides.clone(),
      default_enabled: config.template_registry.enabled,
      default_drift_scan_enabled: config.template_registry.drift_scan_enabled,
    },
    QueueConfig {
      concurrency: config.job.queues.template_registry.concurrency as usize,
      max_attempts: 3,
      ..Default::default()
    },
  );
  info!("template-registry queue handler registered (runtime-toggleable)");

  // pdf-export queue: renders Yjs docs to PDF via the myoxus-pdf-export pipeline.
  // The handler writes PDF bytes to opendal storage via a thin adapter that
  // delegates to ApiState::storage() (the production BlobStoragePort).
  let pdf_blob_writer: std::sync::Arc<dyn myoxus_worker::PdfBlobWriter> =
    std::sync::Arc::new(myoxus_api::pdf_export_adapter::PdfExportBlobWriterAdapter {
      storage: state.storage().clone(),
    });
  // P-PDF-TPL-FONT-01-06: Worker reads approved-license fonts via
  // BlobStoragePort, materializes to a tempdir, and feeds the path into
  // TypstWorld extra_font_dirs.
  let pdf_font_reader: std::sync::Arc<dyn myoxus_worker::PdfFontReader> =
    std::sync::Arc::new(myoxus_api::pdf_export_adapter::PdfExportFontReaderAdapter {
      storage: state.storage().clone(),
    });
  let pdf_asset_reader: std::sync::Arc<dyn myoxus_worker::PdfAssetReader> =
    std::sync::Arc::new(myoxus_api::pdf_export_adapter::PdfExportAssetReaderAdapter {
      storage: state.storage().clone(),
    });
  let pdf_limits = myoxus_worker::PdfExportLimits {
    max_input_blocks: config.pdf_export.limits.max_input_blocks as usize,
    max_pages: config.pdf_export.limits.max_pages as usize,
    render_timeout: std::time::Duration::from_secs(config.pdf_export.limits.render_timeout_seconds),
    max_memory_mb: config.pdf_export.limits.max_memory_mb,
    snapshot_limits: config.pdf_export.edgeless_snapshot_limits(),
  };
  // P6: PDF export observability — adapter that funnels worker render
  // outcomes into the shared MetricsService (category `pdf_export`).
  let pdf_metrics: std::sync::Arc<dyn myoxus_worker::PdfExportMetrics> = std::sync::Arc::new(
    myoxus_api::pdf_export_adapter::PdfExportMetricsAdapter::new(state.metrics_arc()),
  );
  let verapdf_client =
    myoxus_api::pdf_export_adapter::build_verapdf_client(&config.pdf_export, config.additional_ca.as_ref())?;
  // P-PDF-TPL-13: V2 template registry for the async render path. The
  // worker handler resolves `template_id` (slug or UUID) through this
  // registry to materialise the bundle bytes; without it the worker
  // can't render. Same components as the GraphQL admin surface.
  let pdf_worker_registry: std::sync::Arc<dyn myoxus_pdf_export::template_v2::PdfTemplateRegistry> =
    std::sync::Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(
      pool.clone(),
      pdf_template_repo.clone(),
      pdf_blob_store.clone(),
    ));
  redis_worker_runtime.register(
    myoxus_worker::PdfExportJobHandler {
      job_store: state.pdf_export_jobs(),
      doc_service: Arc::new(state.doc().clone()),
      blob_service: state.blob_service(),
      font_repository: state
        .pdf_font_repo()
        .expect("production PDF worker requires the PDF font repository"),
      static_path: bundled_static_fonts_path(),
      blob_writer: pdf_blob_writer,
      font_reader: Some(pdf_font_reader),
      asset_reader: Some(pdf_asset_reader),
      limits: pdf_limits,
      limits_provider: Some(Arc::new(
        myoxus_api::pdf_export_adapter::PdfExportLimitsProviderAdapter {
          state: Arc::new(state.clone()),
        },
      )),
      metrics: pdf_metrics,
      template_registry: pdf_worker_registry,
      verapdf_client,
    },
    QueueConfig {
      concurrency: config.job.queues.pdf_export.concurrency as usize,
      max_attempts: 3,
      ..Default::default()
    },
  );
  info!(
    max_input_blocks = pdf_limits.max_input_blocks,
    max_pages = pdf_limits.max_pages,
    render_timeout_s = pdf_limits.render_timeout.as_secs(),
    "pdf-export queue handler registered"
  );

  // A registered queue must be visible and manageable through AdminRoot.
  for queue_name in redis_worker_runtime.queue_names() {
    if !myoxus_api::admin_queue::ADMIN_QUEUE_NAMES.contains(&queue_name) {
      return Err(format!("registered worker queue {queue_name} is missing from Admin queue inventory").into());
    }
  }
  use myoxus_domain::scheduling::registered::{RegisteredJob as R, RegisteredWorker as W};
  // Preserve the staggered native jobs and current startup payloads. Runtime
  // feature checks remain in their handlers, not in a parallel timing registry.
  let mut registered_workers = vec![
    W::cron(R::CleanUserSessions, "0 0 0 * * *", serde_json::json!({})),
    W::cron(R::CleanHistories, "0 15 0 * * *", serde_json::json!({})),
    W::cron(R::CleanNotifications, "0 30 0 * * *", serde_json::json!({})),
    W::cron(R::CleanPendingBlobs, "0 45 0 * * *", serde_json::json!({})),
    W::cron(R::CleanOutbox, "0 0 1 * * *", serde_json::json!({})),
    W::cron(R::CleanMergedUpdates, "0 0 2 * * *", serde_json::json!({})),
    W::cron(R::CleanGitRepos, "0 0 3 * * *", serde_json::json!({})),
    W::cron(R::CleanSessionLinks, "0 0 3 * * *", serde_json::json!({})),
    W::cron(R::CleanOrphanedBlobs, "0 15 3 * * *", serde_json::json!({})),
    W::cron(R::CleanMultipartUploads, "0 30 3 * * *", serde_json::json!({})),
    W::cron(R::CleanCopilotBlobs, "0 45 3 * * *", serde_json::json!({})),
    W::cron(R::ReconcileStorage, "0 0 4 * * *", serde_json::json!({})),
    W::cron(R::CleanPdfExports, "0 15 4 * * *", serde_json::json!({})),
    W::cron(R::DocumentVersionDaily, "0 30 4 * * *", serde_json::json!({})),
    W::cron(R::DocumentVersionGc, "0 45 4 * * *", serde_json::json!({})),
    W::cron(R::CleanWorkspaceImports, "0 0 5 * * *", serde_json::json!({})),
    W::cron(R::CleanCopilotSessions, "0 30 1 * * *", serde_json::json!({})),
    W::cron(R::GenerateCopilotTitles, "0 45 1 * * *", serde_json::json!({})),
    W::interval(
      R::CountPendingUpdates,
      config.worker.polling.doc_maintenance_interval_ms,
      serde_json::json!({}),
    ),
    W::interval(
      R::FindEmptySummaries,
      config.worker.polling.doc_maintenance_interval_ms,
      serde_json::json!({}),
    ),
    W::interval(R::CaptureDocumentHistory, 30_000, serde_json::json!({})),
    W::interval(
      R::ReindexDocumentGraph,
      config.worker.polling.document_graph_reindex_interval_ms,
      serde_json::json!({
        "workspace_id":null,"limit":config.document_graph.max_reindex_batch,"workspace_limit":config.document_graph.max_catch_up_workspaces,"reason":"catch_up"
      }),
    ),
    W::interval(
      R::RecomputeDatabase,
      config.worker.polling.database_projection_interval_ms,
      serde_json::json!({
        "workspace_id":null,"limit":100,"database_limit":25,"reason":"catch_up"
      }),
    ),
    W::interval(
      R::CaldavSync,
      config.worker.polling.caldav_sync_interval_ms,
      serde_json::json!({}),
    ),
    W::interval(
      R::GoogleCalendarSync,
      config.worker.polling.google_calendar_sync_interval_ms,
      serde_json::json!({}),
    ),
    W::cron(R::GoogleChannelRenewal, "0 0 2 * * *", serde_json::json!({})),
    W::interval(
      R::IndexWorkspaces,
      config.worker.polling.indexer_auto_index_interval_ms,
      serde_json::json!({}),
    ),
    W::interval(
      R::ReconcileTemplates,
      config
        .template_registry
        .drift_scan_interval_seconds
        .saturating_mul(1000),
      serde_json::json!({}),
    ),
    W::cron(R::ScanTemplateDrift, "0 0 2 * * *", serde_json::json!({})),
  ];
  registered_workers.extend(myoxus_api::telemetry_worker::telemetry_schedules(
    config.telemetry.flush_interval_seconds,
  ));
  registered_workers.extend(
    myoxus_api::metrics_worker::metrics_schedules(config.metrics.flush_interval_seconds)
      .into_iter()
      .map(|worker| worker.with_enabled(config.metrics.persistence_enabled)),
  );
  let count = registered_startup
    .register(registered_workers, chrono::Utc::now())
    .await?;
  registered_startup.finish().await?;
  info!(count, "shared registered-worker schedules initialized");

  // No queue worker, delayed promotion or shared admission starts before the
  // stopped-owner transfer and full registration have completed under one lock.
  workspace_automation_runtime.start().await?;
  let mut redis_worker_handles = redis_worker_runtime.spawn();
  let mut automation_shutdown = shutdown_rx.clone();
  redis_worker_handles.push(tokio::spawn(async move {
    while !*automation_shutdown.borrow() {
      if automation_shutdown.changed().await.is_err() {
        break;
      }
    }
    if workspace_automation_runtime
      .shutdown(std::time::Duration::from_secs(30))
      .await
      .is_err()
    {
      tracing::error!("workspace automation runtime did not shut down cleanly");
    }
  }));
  let config_overrides = state.config_overrides.clone();
  redis_worker_handles.push(tokio::spawn(myoxus_api::config_reload::run_config_reload_loop(
    pool.clone(),
    Arc::new(file_config.clone()),
    config_overrides,
    state.transcription_runtime.clone(),
    state.logging().cloned(),
    state.metrics_arc(),
    shutdown_rx.clone(),
    myoxus_api::config_reload::DEFAULT_RELOAD_INTERVAL,
  )));

  // Git-Sync dispatch is independent from ingress. PostgreSQL Pending rows are
  // durable intent and are replayed idempotently after Redis/process recovery.
  redis_worker_handles.push(tokio::spawn(run_git_sync_pending_dispatcher(
    pool.clone(),
    redis_worker_queue.clone(),
    git_sync_runner_config.clone(),
    shutdown_rx.clone(),
  )));

  // Outbox processor: polls outbox_events and enqueues notification jobs.
  redis_worker_handles.push(tokio::spawn(run_outbox_processor(
    pool.clone(),
    redis_worker_queue.clone(),
    state.clone(),
    workspace_content_operation_repository.clone(),
    scheduling,
    shutdown_rx.clone(),
  )));
  redis_worker_handles.push(tokio::spawn(run_workspace_content_queue_reconciler(
    workspace_content_cluster_coordinator,
    shutdown_rx.clone(),
  )));

  redis_worker_handles.push(tokio::spawn(myoxus_api::admin_queue::run_queue_history_sampler(
    redis_worker_queue.clone(),
    shutdown_rx.clone(),
  )));

  // P84-H-21: Cache hit-rate monitor — logs warnings when hit rate drops
  // below 50% for any cache with >100 lookups.  Runs every 5 minutes.
  redis_worker_handles.push(tokio::spawn(myoxus_api::cache::run_cache_hit_rate_monitor(
    state.query_cache.clone(),
    std::time::Duration::from_secs(300),
    shutdown_rx.clone(),
  )));

  // P84-I: Start the cache invalidation Pub/Sub subscriber (if cache Redis is configured).
  // The subscriber needs its own dedicated Redis connection (Pub/Sub requirement),
  // so we create a fresh adapter from the config URL.
  if state.cache_bus.is_some() {
    let (config_refresh_tx, mut config_refresh_rx) = tokio::sync::mpsc::unbounded_channel();
    let refresh_state = state.clone();
    redis_worker_handles.push(tokio::spawn(async move {
      while config_refresh_rx.recv().await.is_some() {
        if let Err(error) = refresh_state.refresh_config_overrides().await {
          warn!(%error, "failed to refresh configuration after Redis invalidation");
        }
      }
    }));
    let cache_url = config.redis.role_url(RedisRole::Cache);
    let cache_ns = config.redis.role_namespace(RedisRole::Cache);
    if let Some(url) = cache_url {
      match myoxus_infrastructure::tls::redis::client(&url, config.additional_ca.as_ref()) {
        Ok(client) => {
          let sub_adapter = myoxus_infrastructure::redis::RedisAdapter::from_client(client, &cache_ns);
          let (sub_handle, _ready) = myoxus_api::cache_bus::CacheInvalidationBus::start_subscriber(
            state.query_cache.clone(),
            Arc::new(sub_adapter),
            instance_id,
            Some(config_refresh_tx),
          );
          redis_worker_handles.push(sub_handle);
          info!("P84-I: cache invalidation subscriber started");
        }
        Err(e) => {
          warn!(error = %e, "P84-I: failed to create subscriber Redis adapter — subscriber not started");
        }
      }
    }
  }

  // P84-J: Apply last daily TTL recommendations from DB (P84-J-19).
  myoxus_api::cache_tuning::apply_startup_ttl_recommendations(&state.query_cache, state.metrics_arc().as_ref()).await;

  // P84-J / P104-B: Start hourly and daily cache TTL tuning background tasks.
  // Doc-cache tuning handles are passed when a cache Redis adapter is configured.
  redis_worker_handles.push(myoxus_api::cache_tuning::start_hourly_tuner(
    state.query_cache.clone(),
    config.cache.clone(),
    state.metrics_arc(),
    state.doc_cache_tuning().cloned(),
  ));
  redis_worker_handles.push(myoxus_api::cache_tuning::start_daily_tuner(
    state.query_cache.clone(),
    config.cache.clone(),
    state.metrics_arc(),
    state.doc_cache_tuning().cloned(),
  ));

  // Capture telemetry handles for graceful-shutdown final flush (P-Telemetry-C,
  // INV-TEL-06) before `state` is moved into the router.
  let telemetry_for_shutdown = state.telemetry_arc();
  let telemetry_batch_max_for_shutdown = config.telemetry.batch_max_events;
  let metrics_for_shutdown = state.metrics_arc();

  state.set_ready(true);
  let app = myoxus_api::build_router(state)?;

  let listener = TcpListener::bind(&config.bind_addr()).await?;
  tracing::info!(bind_addr = %config.bind_addr(), "listening");
  let shutdown_tx_for_server = shutdown_tx.clone();
  axum::serve(listener, app)
    .with_graceful_shutdown(async move {
      shutdown_signal().await;
      let cancelled_doc_loads = myoxus_api::websocket::cancel_all_doc_loads_for_shutdown();
      tracing::info!(cancelled_doc_loads, "cancelled in-flight document loads for shutdown");
      if shutdown_tx_for_server.send(true).is_err() {
        tracing::warn!("shutdown signal: no receivers");
      }
    })
    .await?;

  // Drain the telemetry and metrics buffers after HTTP shutdown while their
  // service-owned PostgreSQL handles are still alive.
  myoxus_api::telemetry_worker::flush_on_shutdown(&telemetry_for_shutdown, telemetry_batch_max_for_shutdown).await;
  myoxus_api::metrics_worker::flush_on_shutdown(&metrics_for_shutdown, config.metrics.persistence_enabled).await;

  if shutdown_tx.send(true).is_err() {
    tracing::warn!("shutdown signal: no receivers");
  }
  let shutdown_timeout = std::time::Duration::from_secs(config.server.shutdown_timeout_seconds);
  for handle in redis_worker_handles.drain(..) {
    match tokio::time::timeout(shutdown_timeout, handle).await {
      Err(_) => tracing::warn!(
        timeout_s = shutdown_timeout.as_secs(),
        "worker did not shut down within timeout"
      ),
      Ok(Err(e)) => tracing::warn!(error = %e, "worker task panicked during shutdown"),
      Ok(Ok(())) => {}
    }
  }

  Ok(())
}

// ─── Database Job Enqueuer (P-DB-25) ───────────────────────────────────────

/// P-DB-25: bridge between the Database services' queue-agnostic
/// `DatabaseJobEnqueuer` port and the concrete Redis-backed queue.
/// The application layer never depends on the worker crate, so this
/// adapter is the only place that knows how to build a `JobOptions`
/// from the typed `delay_ms` value.
struct RedisDatabaseJobEnqueuer {
  queue: myoxus_worker::RedisQueue,
}

impl RedisDatabaseJobEnqueuer {
  fn new(queue: myoxus_worker::RedisQueue) -> Self {
    Self { queue }
  }
}

#[async_trait::async_trait]
impl myoxus_application::database::DatabaseJobEnqueuer for RedisDatabaseJobEnqueuer {
  async fn enqueue(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    delay_ms: i64,
  ) -> Result<String, String> {
    use myoxus_worker::job::JobOptions;
    let opts = JobOptions {
      delay_ms: Some(delay_ms),
      max_attempts: 3,
      ..Default::default()
    };
    self
      .queue
      .enqueue(queue, job_name, data, opts)
      .await
      .map_err(|error| error.to_string())
  }
}

// ─── Queue Handlers ──────────────────────────────────────────────────────────

fn calendar_mail_job_error(error: myoxus_application::auth::AuthError) -> myoxus_worker::JobError {
  match error {
    myoxus_application::auth::AuthError::InvalidInput(message) => myoxus_worker::JobError::Permanent(message),
    myoxus_application::auth::AuthError::Storage(message) => myoxus_worker::JobError::Retryable(message),
    _ => myoxus_worker::JobError::Retryable("Calendar mail unavailable".into()),
  }
}

/// Notification queue handler.
///
/// Job names use BullMQ format: `"notification.sendInvitation"`, etc.
/// Each job payload must include `userId` (the recipient) and may include
/// `notificationType`, `level`, `idempotencyKey`, and `payload` fields.
///
/// For backward compatibility, if `notificationType` is absent, it is inferred
/// from the job name.
struct NotificationQueueHandler {
  state: ApiState,
  calendar_mail_dispatcher: myoxus_application::calendar::mail::CalendarSchedulingMailDispatcher,
  notification_adapter: Option<Arc<RedisWsAdapter>>,
  notification_service: Arc<myoxus_application::notification::NotificationService>,
  mail: Arc<dyn MailPort>,
  auth_store: Arc<dyn myoxus_application::auth::AuthStore>,
  database_reminders: Option<Arc<myoxus_application::database::DatabaseReminderService>>,
  database_pool: sqlx::PgPool,
  database_repository: Arc<myoxus_infrastructure::workspace_database::PgDatabaseRepository>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for NotificationQueueHandler {
  fn queue_name(&self) -> &str {
    "notification"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let data = &job.data;
    let job_name = job.name.as_str();

    if job_name == "notification.sendDatabaseTaskNotification" {
      return myoxus_api::database_task_notification::dispatch(
        &self.database_pool,
        &self.state,
        data,
        self.database_repository.clone(),
      )
      .await
      .map(Some);
    }

    if job_name == "notification.sendCalendarMail" {
      let intent = myoxus_application::calendar::mail::CalendarSchedulingMailIntent::from_payload(data)
        .map_err(calendar_mail_job_error)?;
      self
        .calendar_mail_dispatcher
        .dispatch(&intent)
        .await
        .map_err(calendar_mail_job_error)?;
      return Ok(Some(serde_json::json!({"delivered":true})));
    }

    if job_name == "notification.sendDatabaseRowReminder" {
      myoxus_api::database_reminder_notification::dispatch_database_row_reminder_notification(
        &self.notification_service,
        self.notification_adapter.as_deref(),
        self.database_reminders.as_deref(),
        data,
      )
      .await?;
      return Ok(None);
    }

    if job_name == "notification.sendComment" {
      let notification = myoxus_api::comment_notification::dispatch_comment_notification(&self.state, data).await?;
      return Ok(Some(match notification {
        Some(notification) => serde_json::json!({"notificationId": notification.id}),
        None => serde_json::json!({"suppressed": true}),
      }));
    }

    // Handle sendMail: dispatch to MailPort based on template name.
    if job_name == "notification.sendMail" {
      let to = data["to"].as_str().unwrap_or("").to_string();
      let template = data["template"].as_str().unwrap_or("").to_string();
      let params = &data["params"];

      if to.is_empty() {
        tracing::warn!(job_id = %job.id, "notification.sendMail missing 'to' field, skipping");
        return Ok(None);
      }
      if template.is_empty() {
        tracing::warn!(job_id = %job.id, %to, "notification.sendMail missing 'template' field, skipping");
        return Ok(None);
      }

      tracing::info!(job_id = %job.id, %to, %template, "dispatching notification.sendMail");

      let result = match template.as_str() {
        "magic-link" | "email-verification" | "password-reset" | "change-email" => {
          // Deployed jobs carry an address, so resolve its account once in the
          // Auth producer; the transport receives only prepared presentation.
          let recipient = self
            .auth_store
            .get_user_by_email(&to)
            .await
            .map_err(|error| JobError::Retryable(error.to_string()))?;
          let mail_template = match template.as_str() {
            "magic-link" if params["isSignup"].as_bool().unwrap_or(false) => {
              myoxus_application::ports::MailTemplate::Welcome
            }
            "magic-link" => myoxus_application::ports::MailTemplate::SignIn,
            "email-verification" => myoxus_application::ports::MailTemplate::VerifyEmail,
            "password-reset" => myoxus_application::ports::MailTemplate::PasswordReset,
            _ => myoxus_application::ports::MailTemplate::ChangeEmail,
          };
          let mut context = serde_json::json!({"url": params["link"].as_str().unwrap_or("")});
          if template == "magic-link" {
            context["otp"] = serde_json::json!(params["otp"].as_str().unwrap_or(""));
          }
          let mail = self
            .state
            .auth()
            .prepare_mail_for_user(recipient.map(|user| user.id), &to, mail_template, context)
            .await
            .map_err(|error| JobError::Retryable(error.to_string()))?;
          self.mail.send_template(mail).await
        }
        "comment-mention" => {
          // Deployed pending mail jobs lack a user ID. Resolve the account now;
          // queued addresses and flags must not bypass its current opt-out.
          let recipient = self
            .auth_store
            .get_user_by_email(&to)
            .await
            .map_err(|error| JobError::Retryable(error.to_string()))?;
          if let Some(recipient) = recipient {
            self
              .notification_service
              .dispatch_notification_email(recipient.id, "comment_mention", params)
              .await;
          }
          return Ok(None);
        }
        "doc-shared" => {
          if let Some(recipient) = self
            .auth_store
            .get_user_by_email(&to)
            .await
            .map_err(|error| JobError::Retryable(error.to_string()))?
          {
            self
              .notification_service
              .dispatch_notification_email(recipient.id, "doc_shared", params)
              .await;
          }
          return Ok(None);
        }
        "workspace-invitation" => {
          // The notification job path owns invitation preferences and live projection.
          tracing::debug!(job_id = %job.id, %to, "workspace-invitation template handled by notification path, skipping sendMail");
          return Ok(None);
        }
        unknown => {
          tracing::warn!(job_id = %job.id, %to, template = %unknown, "notification.sendMail: unknown template, skipping");
          return Ok(None);
        }
      };

      if let Err(e) = result {
        tracing::error!(job_id = %job.id, %to, %template, error = %e, "notification.sendMail delivery failed");
        // Return OK to avoid poisoning the queue — mail delivery failures are best-effort.
      } else {
        tracing::info!(job_id = %job.id, %to, %template, "notification.sendMail delivered successfully");
      }
      return Ok(None);
    }

    let user_id: uuid::Uuid = data["userId"]
      .as_str()
      .ok_or_else(|| JobError::Permanent(format!("notification job '{}' missing userId", job_name)))
      .and_then(|s| {
        s.parse()
          .map_err(|_| JobError::Permanent(format!("invalid userId in notification job: {s}")))
      })?;

    // Infer notification type from job name if not explicitly set.
    let notification_type = data["notificationType"]
      .as_str()
      .map(str::to_string)
      .unwrap_or_else(|| match job_name {
        "notification.sendInvitation" => "invitation".to_string(),
        "notification.sendInvitationAccepted" => "invitation_accepted".to_string(),
        "notification.sendInvitationReviewRequest" => "invitation_review_request".to_string(),
        "notification.sendInvitationReviewApproved" => "invitation_review_approved".to_string(),
        "notification.sendInvitationReviewDeclined" => "invitation_review_declined".to_string(),
        // P100-SRV-F-03/F-05/F-08: access_change-derived jobs.
        "notification.sendInviteAccepted" => "invitation_accepted".to_string(),
        "notification.sendAdminAdded" => "member_added".to_string(),
        _ => "general".to_string(),
      });

    let level = data["level"].as_str().map(str::to_string);
    let idempotency_key = data["idempotencyKey"]
      .as_str()
      .or_else(|| data["inviteId"].as_str())
      .map(str::to_string);
    let payload = data.clone();

    tracing::info!(
      job_id = %job.id,
      job_name,
      %user_id,
      notification_type = %notification_type,
      queue = "notification",
      "processing notification job"
    );

    let notification = self
      .notification_service
      .create_notification(user_id, notification_type, level, idempotency_key, payload)
      .await
      .map_err(|e| {
        tracing::error!(job_id = %job.id, error = %e, "failed to create notification");
        JobError::Retryable(e.to_string())
      })?;

    // P100-SRV-F-04/F-05: Push notification_new event to open WebSocket sessions.
    myoxus_api::websocket::publish_user_notification(
      self.notification_adapter.as_deref(),
      user_id,
      "notification_new",
      serde_json::json!({
        "notificationId": notification.id,
        "notificationType": notification.notification_type,
        "payload": notification.payload,
      }),
    )
    .await;
    tracing::debug!(
      job_id = %job.id,
      %user_id,
      notification_id = %notification.id,
      "notification_new pushed to WebSocket fanout"
    );

    Ok(None)
  }
}

/// Doc queue handler.
///
/// Handles:
/// - `"doc.mergePendingDocUpdates"` — merges pending updates into a snapshot
/// - `"doc.recordPendingDocUpdatesCount"` — logs pending update counts for monitoring
/// - `"doc.findEmptySummaryDocs"` — finds docs without titles and enqueues fix jobs
/// - `"doc.autoFixedDocSummary"` — attempts to fill in a missing doc title
struct DocQueueHandler {
  doc_service: Arc<DocService>,
  queue: myoxus_worker::RedisQueue,
  edit_capture_service: myoxus_application::document_version::DocumentEditCaptureService,
  config: Arc<myoxus_api::config::AppConfig>,
  config_overrides: Arc<tokio::sync::RwLock<myoxus_api::config_reload::ConfigOverrides>>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for DocQueueHandler {
  fn queue_name(&self) -> &str {
    "doc"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "doc", "processing doc job");

    match job_name {
      "doc.mergePendingDocUpdates" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("doc.mergePendingDocUpdates missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        let doc_id: uuid::Uuid = job.data["docId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("doc.mergePendingDocUpdates missing docId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid docId: {s}")))
          })?;

        let merged = self
          .doc_service
          .merge_pending_updates(workspace_id, doc_id, 1)
          .await
          .map_err(|e| {
            tracing::error!(job_id = %job.id, %doc_id, error = %e, "merge_pending_updates failed");
            JobError::Retryable(e.to_string())
          })?;

        tracing::info!(job_id = %job.id, %doc_id, merged_count = merged, "doc pending updates merged");
        Ok(Some(serde_json::json!({ "merged": merged })))
      }

      "doc.recordPendingDocUpdatesCount" => {
        let count = self.doc_service.count_all_pending_updates().await.map_err(|e| {
          tracing::warn!(job_id = %job.id, error = %e, "count_all_pending_updates failed");
          JobError::Retryable(e.to_string())
        })?;
        tracing::info!(job_id = %job.id, pending_doc_updates = count, "recorded pending doc updates count");
        Ok(Some(serde_json::json!({ "pendingDocUpdates": count })))
      }

      "doc.captureDueDocumentHistory" => {
        let overrides = self.config_overrides.read().await;
        let mut global = myoxus_application::document_version::GlobalEditCaptureSettings::default();
        global.enabled = overrides
          .overrides
          .get("doc.history.enabled")
          .and_then(serde_json::Value::as_bool)
          .unwrap_or(self.config.doc.history.enabled);
        global.interval_ms = overrides
          .overrides
          .get("doc.history.interval")
          .and_then(serde_json::Value::as_i64)
          .unwrap_or_else(|| i64::try_from(self.config.doc.history.interval).unwrap_or(i64::MAX));
        drop(overrides);
        let summary = tokio::time::timeout(
          std::time::Duration::from_secs(20),
          self
            .edit_capture_service
            .run_once(&global, chrono::Utc::now(), 200, 100),
        )
        .await
        .map_err(|_| JobError::Retryable("captureDueDocumentHistory timed out".to_string()))?
        .map_err(|error| JobError::Retryable(format!("captureDueDocumentHistory: {error}")))?;
        Ok(Some(
          serde_json::to_value(summary).unwrap_or_else(|_| serde_json::json!({})),
        ))
      }

      "doc.findEmptySummaryDocs" => {
        // The repository returns only ordinary documents with pending updates.
        // Root/system docs do not own visible titles, and a titleless document
        // without new updates must not be queued forever.
        let candidates = self
          .doc_service
          .find_title_backfill_candidates(100)
          .await
          .map_err(|e| {
            tracing::error!(job_id = %job.id, error = %e, "findEmptySummaryDocs lookup failed");
            JobError::Retryable(e.to_string())
          })?;

        let found = candidates.len();
        for candidate in candidates {
          let workspace_id = candidate.workspace_id;
          let doc_id = candidate.doc_id;
          let opts = myoxus_worker::JobOptions::default();
          if let Err(e) = self
            .queue
            .enqueue(
              "doc",
              "doc.autoFixedDocSummary",
              serde_json::json!({ "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }),
              opts,
            )
            .await
          {
            tracing::warn!(job_id = %job.id, %doc_id, error = %e, "failed to enqueue doc.autoFixedDocSummary");
          }
        }

        tracing::info!(job_id = %job.id, found, "findEmptySummaryDocs: enqueued fix jobs");
        Ok(Some(serde_json::json!({ "found": found })))
      }

      "doc.autoFixedDocSummary" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("doc.autoFixedDocSummary missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        let doc_id: uuid::Uuid = job.data["docId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("doc.autoFixedDocSummary missing docId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid docId: {s}")))
          })?;

        let meta = self
          .doc_service
          .get_metadata(doc_id)
          .await
          .map_err(|e| JobError::Retryable(e.to_string()))?;

        if let Some(doc) = meta {
          if doc.title.is_empty() {
            // `save_snapshot` extracts the title from the merged Yjs state in
            // the same transaction. It also consumes the selected pending
            // updates, so an intrinsically untitled document will not be
            // selected again until it receives new content.
            let merged = self.doc_service.merge_pending_updates(workspace_id, doc_id, 1)
              .await
              .map_err(|e| {
                tracing::warn!(job_id = %job.id, %doc_id, error = %e, "autoFixedDocSummary: merge_pending_updates failed");
                JobError::Retryable(e.to_string())
              })?;
            tracing::info!(job_id = %job.id, %doc_id, merged, "autoFixedDocSummary: merged pending updates for title fix");
          } else {
            tracing::debug!(job_id = %job.id, %doc_id, "autoFixedDocSummary: doc already has title, skipping");
          }
        } else {
          tracing::debug!(job_id = %job.id, %doc_id, "autoFixedDocSummary: doc not found, skipping");
        }
        Ok(None)
      }

      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown doc job type, skipping");
        Ok(None)
      }
    }
  }
}

/// Nightly cleanup queue handler.
///
/// Job names use BullMQ format: `"nightly.cleanExpiredUserSessions"`, etc.
/// Retention periods come from canonical live configuration (`cleanup.*`,
/// with Git-Sync SQL history owned by `git_sync.retention_days`).
struct NightlyQueueHandler {
  pool: sqlx::PgPool,
  config: Arc<myoxus_api::config::AppConfig>,
  config_overrides: Arc<tokio::sync::RwLock<myoxus_api::config_reload::ConfigOverrides>>,
  blob_storage: Arc<dyn myoxus_application::ports::BlobStoragePort>,
  doc_service: Arc<DocService>,
  document_version_repo: Arc<dyn myoxus_domain::repositories::DocumentVersionRepository>,
  document_version_settings_repo: Arc<dyn myoxus_domain::repositories::DocumentVersioningSettingsRepository>,
  audit_recorder: myoxus_application::audit::AuditRecorder,
  workspace_import_service: Arc<myoxus_application::workspace_import::WorkspaceImportService>,
  pdf_export_cleanup: Arc<myoxus_application::pdf_export::cleanup::PdfExportCleanupService>,
  retention: myoxus_application::maintenance::RetentionService,
  blob_maintenance: Arc<myoxus_infrastructure::blob::SqlxBlobStore>,
  copilot_service: Arc<CopilotService>,
  git_sync_locks: myoxus_api::git_sync_engine::locking::ProfileLocks,
  git_sync_lock_redis: Arc<dyn RedisPort>,
}

impl NightlyQueueHandler {
  async fn retention_value(&self, path: &str) -> i64 {
    let fallback = match path {
      "cleanup.history_retention_days" => self.config.cleanup.history_retention_days,
      "cleanup.notification_retention_days" => self.config.cleanup.notification_retention_days,
      "cleanup.pending_blob_retention_hours" => self.config.cleanup.pending_blob_retention_hours,
      "cleanup.outbox_retention_days" => self.config.cleanup.outbox_retention_days,
      _ => unreachable!("nightly retention paths are statically owned"),
    };
    self
      .config_overrides
      .read()
      .await
      .overrides
      .get(path)
      .and_then(serde_json::Value::as_i64)
      .unwrap_or(fallback)
  }
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for NightlyQueueHandler {
  fn queue_name(&self) -> &str {
    "nightly"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "nightly", "processing nightly cleanup job");
    match job_name {
      "nightly.cleanExpiredUserSessions" => {
        let total = self
          .retention
          .clean_expired_sessions()
          .await
          .map_err(|error| JobError::Retryable(format!("cleanExpiredUserSessions: {error}")))?;
        Ok(Some(serde_json::json!({ "rows_affected": total })))
      }
      "nightly.cleanExpiredHistories" => {
        // FIXED: targets doc_histories (point-in-time backups), NOT doc_snapshots (primary content).
        // doc_snapshots must NEVER be deleted by a cleanup job.
        let days = self.retention_value("cleanup.history_retention_days").await;
        let total = self
          .retention
          .clean_document_histories(days)
          .await
          .map_err(|error| JobError::Retryable(format!("cleanExpiredHistories: {error}")))?;
        Ok(Some(
          serde_json::json!({ "rows_affected": total, "retentionDays": days }),
        ))
      }
      "nightly.cleanExpiredNotifications" => {
        let days = self.retention_value("cleanup.notification_retention_days").await;
        let total = self
          .retention
          .clean_notifications(days)
          .await
          .map_err(|error| JobError::Retryable(format!("cleanExpiredNotifications: {error}")))?;
        Ok(Some(
          serde_json::json!({ "rows_affected": total, "retentionDays": days }),
        ))
      }
      "nightly.cleanExpiredPendingBlobs" => {
        let hours = self.retention_value("cleanup.pending_blob_retention_hours").await;
        let total = self
          .retention
          .clean_pending_blobs(hours)
          .await
          .map_err(|error| JobError::Retryable(format!("cleanExpiredPendingBlobs: {error}")))?;
        Ok(Some(
          serde_json::json!({ "rows_affected": total, "retentionHours": hours }),
        ))
      }
      "nightly.cleanProcessedOutboxEvents" => {
        let days = self.retention_value("cleanup.outbox_retention_days").await;
        let total = self
          .retention
          .clean_processed_outbox_events(days)
          .await
          .map_err(|error| JobError::Retryable(format!("cleanProcessedOutboxEvents: {error}")))?;
        Ok(Some(
          serde_json::json!({ "rows_affected": total, "retentionDays": days }),
        ))
      }
      "nightly.cleanMergedDocUpdates" => {
        // NIGHTLY-ROB-03: Uses a transaction to prevent race with concurrent snapshot merges.
        // NIGHTLY-ROB-04: Batched to avoid long locks.
        // Selects candidate IDs first (with a snapshot-consistent read), then deletes by ID.
        let total = self
          .retention
          .clean_merged_document_updates()
          .await
          .map_err(|error| JobError::Retryable(format!("cleanMergedDocUpdates: {error}")))?;
        Ok(Some(serde_json::json!({ "rows_affected": total })))
      }
      "nightly.cleanStaleGitSyncRepos" => {
        let effective = myoxus_api::config_reload::EffectiveConfig::new(
          self.config.clone(),
          Arc::new(self.config_overrides.read().await.clone()),
        );
        let retention_days = effective.git_sync_retention_days().map_err(JobError::Permanent)?;
        let maintenance = myoxus_api::git_sync_engine::maintenance::GitSyncMaintenance::new(
          myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(self.pool.clone()),
          std::path::PathBuf::from(&self.config.git_sync.repo_base_dir),
          self.git_sync_locks.clone(),
          self.git_sync_lock_redis.clone(),
          self.config.git_sync.lock_ttl_seconds,
        );
        let report = maintenance
          .cleanup_with_retention(retention_days)
          .await
          .map_err(|error| {
            tracing::error!(%error, "cleanStaleGitSyncRepos failed closed and preserved unverified paths");
            JobError::Retryable(format!("cleanStaleGitSyncRepos: {error}"))
          })?;
        tracing::info!(
          cleaned_canonical_mirrors = report.cleaned_canonical_mirrors,
          cleaned_staging = report.cleaned_staging,
          retained_existing_mirrors = report.retained_existing_mirrors,
          retained_current_staging = report.retained_current_staging,
          retained_unfinished_staging = report.retained_unfinished_staging,
          retained_busy_candidates = report.retained_busy_candidates,
          retained_unknown_entries = report.retained_unknown_entries,
          sql_deleted_rows = report.sql_history.deleted.values().sum::<u64>(),
          sql_protected_profiles = report.sql_history.protected_profiles,
          sql_busy_profiles = report.sql_history.busy_profiles,
          sql_budget_exhausted = report.sql_history.budget_exhausted,
          "conservative Git-Sync maintenance completed"
        );
        Ok(Some(serde_json::json!({
          "retentionDays": retention_days,
          "sqlHistory": report.sql_history,
          "cleaned": report.cleaned_canonical_mirrors,
          "cleanedStaging": report.cleaned_staging,
          "retainedExistingMirrors": report.retained_existing_mirrors,
          "retainedCurrentStaging": report.retained_current_staging,
          "retainedUnfinishedStaging": report.retained_unfinished_staging,
          "retainedBusyCandidates": report.retained_busy_candidates,
          "retainedUnknownEntries": report.retained_unknown_entries,
        })))
      }
      "nightly.cleanOrphanedSessionLinks" => {
        let total = self
          .retention
          .clean_orphaned_session_links()
          .await
          .map_err(|error| JobError::Retryable(format!("cleanOrphanedSessionLinks: {error}")))?;
        Ok(Some(serde_json::json!({ "rows_affected": total })))
      }
      "nightly.cleanOrphanedBlobs" => {
        // Orphans have no Workspace record; a soft-deletion timestamp never
        // authorizes purging bytes needed by administrative recovery.
        let grace_hours = 24;

        // Find old registry rows whose Workspace record is absent.
        let cleanup = self
          .blob_maintenance
          .clean_orphaned_workspace_blobs(grace_hours, 500, 10_000)
          .await
          .map_err(|error| JobError::Retryable(format!("cleanOrphanedBlobs: {error}")))?;

        let workspace_count = cleanup.workspaces.len();
        let total_blob_count: i64 = cleanup.workspaces.iter().map(|(_, count)| count).sum();

        if workspace_count == 0 {
          tracing::info!(grace_hours, "cleanOrphanedBlobs: no orphaned blobs found");
          return Ok(Some(serde_json::json!({
            "orphanedWorkspaces": 0,
            "orphanedBlobRows": 0,
            "graceHours": grace_hours,
          })));
        }

        tracing::warn!(
          workspace_count,
          total_blob_count,
          grace_hours,
          "cleanOrphanedBlobs: found old blob rows without Workspace records"
        );

        // Step 2: Log per-workspace details so operators can investigate.
        for (ws_id, blob_count) in &cleanup.workspaces {
          tracing::warn!(
            workspace_id = %ws_id,
            blob_count,
            "cleanOrphanedBlobs: absent Workspace has orphaned blob rows"
          );
        }

        // Step 3: Collect blob keys for the affected workspaces (cap at 10 000 to
        // avoid unbounded memory use).
        tracing::info!(
          orphan_key_count = cleanup.orphan_key_count,
          "cleanOrphanedBlobs: collected orphaned blob keys for cleanup"
        );

        // Step 4: Delete the orphaned blob rows from the DB.  Storage file removal
        // is best-effort — if the files are already gone (happy path) this is a no-op;
        // if they are not, they will be collected by storage-level lifecycle rules or
        // a future storage-scanning job.
        let deleted_rows = cleanup.deleted_rows;

        tracing::info!(
          workspace_count,
          deleted_rows,
          grace_hours,
          "cleanOrphanedBlobs: orphaned blob rows removed"
        );

        Ok(Some(serde_json::json!({
          "orphanedWorkspaces": workspace_count,
          "orphanedBlobRows": total_blob_count,
          "deletedRows": deleted_rows,
          "graceHours": grace_hours,
        })))
      }
      "nightly.cleanStaleMultipartUploads" => {
        // MED-11: Find blobs with non-null upload_id created > 24h ago.
        // These are abandoned multipart uploads where the client disconnected
        // before completing or aborting. We clear the upload_id and set status
        // to 'failed'. The actual storage-backend abort (freeing S3 parts) is
        // best-effort — if the backend has lifecycle rules, they will also clean up.
        let hours = 24;
        let count = self
          .blob_maintenance
          .clean_stale_multipart_uploads(hours, 1000)
          .await
          .map_err(|error| JobError::Retryable(format!("clean stale multipart uploads: {error}")))?;
        tracing::info!(
          cleaned = count,
          retention_hours = hours,
          "stale multipart upload cleanup completed"
        );
        Ok(Some(serde_json::json!({ "cleaned": count, "retentionHours": hours })))
      }
      "nightly.reconcileStorageStats" => {
        // BF-SRV-02e: Recalculate workspace storage stats from source tables
        // and write a daily snapshot for trend charts.
        let today = chrono::Utc::now().date_naive();
        let reconciled = self
          .blob_maintenance
          .reconcile_workspace_storage_stats(today)
          .await
          .map_err(|error| JobError::Retryable(format!("reconcile storage stats: {error}")))?;

        tracing::info!(reconciled, "reconciled workspace storage stats");
        Ok(Some(serde_json::json!({ "reconciled": reconciled })))
      }
      "nightly.cleanOrphanedCopilotBlobs" => {
        // P100-SRV-H-09c: Delete copilot blobs (blob_key values stored in
        // copilot_messages JSONB) that are not referenced by any active
        // copilot session.  Copilot messages are CASCADE-deleted when their
        // session is deleted, but the actual blob files in storage remain.
        //
        // Strategy:
        //  1. Extract all blob_key strings from active copilot_messages.
        //  2. Extract all blob_key strings from orphaned messages (sessions
        //     that no longer exist — possible if CASCADE failed or if
        //     message rows were inserted without a valid session).
        //     In practice these should be rare; this job catches the edge case.
        //  3. Delete storage objects for orphaned keys (best-effort).
        //  4. Log the count of deleted blobs.
        //
        // Note: copilot blobs are stored directly in blob storage under the
        // configured storage_prefix (default "copilot/"); they are NOT tracked
        // in the `blobs` DB table, so this job operates on JSONB extraction.

        let storage_prefix = self.config.copilot.storage_prefix.trim_end_matches('/').to_string();

        // Step 1: Collect all blob_key values from active sessions.
        // A session is "active" if a corresponding row exists in copilot_sessions.
        // We extract the blobKey field from within the __attachmentRefs JSON array
        // embedded in each message's content JSONB.
        let active_keys = self
          .copilot_service
          .active_attachment_blob_keys()
          .await
          .map_err(|error| JobError::Retryable(format!("cleanOrphanedCopilotBlobs: {error}")))?;

        tracing::debug!(
          active_count = active_keys.len(),
          "cleanOrphanedCopilotBlobs: collected active blob keys"
        );

        // Step 2: Collect blob_key values from messages whose session no longer
        // exists.  Normally CASCADE prevents these, but we guard against it.
        let orphaned_keys = self
          .copilot_service
          .orphaned_attachment_blob_keys()
          .await
          .map_err(|error| JobError::Retryable(format!("cleanOrphanedCopilotBlobs: {error}")))?;

        if orphaned_keys.is_empty() {
          tracing::info!(
            active_blob_count = active_keys.len(),
            storage_prefix,
            "cleanOrphanedCopilotBlobs: no orphaned copilot blobs found"
          );
          return Ok(Some(serde_json::json!({
            "deletedBlobs": 0,
            "activeBlobCount": active_keys.len(),
          })));
        }

        tracing::warn!(
          orphaned_count = orphaned_keys.len(),
          "cleanOrphanedCopilotBlobs: found orphaned copilot blob keys — deleting from storage"
        );

        // Step 3: Delete orphaned blobs from storage (best-effort).
        let mut deleted = 0usize;
        let mut errors = 0usize;
        for key in &orphaned_keys {
          let storage_key = if key.starts_with(&storage_prefix) {
            key.clone()
          } else {
            format!("{storage_prefix}/{key}")
          };
          match self.blob_storage.delete_blob(&storage_key).await {
            Ok(_) => {
              deleted += 1;
              tracing::trace!(key = %storage_key, "cleanOrphanedCopilotBlobs: deleted blob");
            }
            Err(e) => {
              errors += 1;
              tracing::warn!(key = %storage_key, error = %e, "cleanOrphanedCopilotBlobs: failed to delete blob (non-fatal)");
            }
          }
        }

        tracing::info!(
          deleted,
          errors,
          orphaned_count = orphaned_keys.len(),
          "cleanOrphanedCopilotBlobs: cleanup complete"
        );

        Ok(Some(serde_json::json!({
          "deletedBlobs": deleted,
          "deleteErrors": errors,
          "orphanedCount": orphaned_keys.len(),
          "activeBlobCount": active_keys.len(),
        })))
      }
      "nightly.cleanExpiredPdfExportJobs" => {
        // #314: Purge expired PDF export job rows and their output blobs.
        // Implementation lives in `myoxus_api::pdf_export_cleanup` so it can be
        // unit-tested without the BullMQ runtime.
        let report = myoxus_api::pdf_export_cleanup::clean_expired_pdf_export_jobs(&self.pdf_export_cleanup)
          .await
          .map_err(|e| JobError::Retryable(format!("cleanExpiredPdfExportJobs: {e}")))?;
        Ok(Some(serde_json::json!({
          "expiredJobs": report.expired_jobs,
          "deletedJobs": report.deleted_jobs,
          "deletedBlobs": report.deleted_blobs,
          "deletedBlobRows": report.deleted_blob_rows,
          "deleteErrors": report.delete_errors,
        })))
      }
      "nightly.documentVersionDaily" => {
        let service = myoxus_application::document_version::DocumentVersionAutoTriggerService::new(
          self.doc_service.clone(),
          self.document_version_repo.clone(),
          self.document_version_settings_repo.clone(),
        );
        let report = service
          .run_daily()
          .await
          .map_err(|e| JobError::Retryable(format!("documentVersionDaily: {e}")))?;
        Ok(Some(
          serde_json::to_value(report).unwrap_or_else(|_| serde_json::json!({})),
        ))
      }
      "nightly.documentVersionGc" => {
        let targets = self
          .document_version_settings_repo
          .list_retention_targets()
          .await
          .map_err(|e| JobError::Retryable(format!("documentVersionGc:listTargets: {e}")))?;
        let mut deleted_total = 0usize;
        let mut failed = 0usize;
        for target in &targets {
          match self
            .document_version_repo
            .gc_unpinned_older_than_count(target.doc_id, target.retention_count)
            .await
          {
            Ok(deleted) => {
              deleted_total += deleted.len();
              for version in deleted {
                self
                  .audit_recorder
                  .record(myoxus_domain::audit::AuditEvent::mutation(
                    "document_version.gc.delete",
                    myoxus_domain::audit::AuditCategory::DocumentVersion,
                    Some(myoxus_domain::audit::AuditTarget::entity(
                      "document_version",
                      version.id,
                      Some(version.label.clone()),
                    )),
                    myoxus_domain::audit::AuditActor::system(),
                    Some(serde_json::json!({
                      "docId": version.doc_id,
                      "workspaceId": version.workspace_id,
                      "docHistoryId": version.doc_history_id,
                      "label": version.label,
                      "retentionCount": target.retention_count,
                    })),
                    None,
                  ))
                  .await;
              }
            }
            Err(err) => {
              failed += 1;
              tracing::warn!(
                doc_id = %target.doc_id,
                workspace_id = %target.workspace_id,
                retention_count = target.retention_count,
                error = %err,
                "document version retention GC failed for target"
              );
            }
          }
        }
        tracing::info!(
          targets = targets.len(),
          deleted = deleted_total,
          failed,
          "document version retention GC finished"
        );
        Ok(Some(serde_json::json!({
          "targets": targets.len(),
          "deleted": deleted_total,
          "failed": failed,
        })))
      }
      "nightly.cleanExpiredWorkspaceImports" => {
        let purged = self
          .workspace_import_service
          .cleanup_retained_imports(250)
          .await
          .map_err(|_| JobError::Retryable("workspace import retention cleanup failed".to_string()))?;
        tracing::info!(purged, "workspace import retention cleanup completed");
        Ok(Some(serde_json::json!({ "imports_purged": purged })))
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown nightly job type, skipping");
        Ok(None)
      }
    }
  }
}

/// Workspace queue handler.
///
/// Handles:
/// - `"workspace.cleanupBlobs"` — delete blob files from storage for a deleted workspace.
///   Payload: `{ "workspaceId": "...", "blobKeys": ["key1", "key2", ...] }`
///   AdminRoot snapshots keys before permanent SQL deletion and enqueues this job
///   afterward. Every retained Workspace row protects its bytes from older jobs.
struct WorkspaceQueueHandler {
  blob_storage: Arc<dyn myoxus_application::ports::BlobStoragePort>,
  blob_maintenance: Arc<myoxus_infrastructure::blob::SqlxBlobStore>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for WorkspaceQueueHandler {
  fn queue_name(&self) -> &str {
    "workspace"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "workspace", "processing workspace job");

    match job_name {
      "workspace.cleanupBlobs" => {
        // P100-SRV-A: Delete OpenDAL blob files for a workspace that was cascade-deleted.
        let workspace_id = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("workspace.cleanupBlobs missing workspaceId".to_string()))?;
        let blob_keys = job.data["blobKeys"]
          .as_array()
          .ok_or_else(|| JobError::Permanent("workspace.cleanupBlobs missing blobKeys array".to_string()))?;
        let id = uuid::Uuid::parse_str(workspace_id)
          .map_err(|_| JobError::Permanent("workspace.cleanupBlobs invalid workspaceId".into()))?;
        // Old soft-delete callers could enqueue this purge job. Any retained
        // Workspace record protects its bytes, including trash and archives.
        if self
          .blob_maintenance
          .workspace_record_exists(id)
          .await
          .map_err(|_| JobError::Retryable("workspace.cleanupBlobs purge check unavailable".into()))?
        {
          tracing::info!(workspace_id, "retained Workspace protects blobs from purge job");
          return Ok(Some(serde_json::json!({"skipped":true,"deleted":0})));
        }

        let total = blob_keys.len();
        let mut deleted = 0usize;
        let mut failed = 0usize;

        for key_val in blob_keys {
          let Some(key) = key_val.as_str() else { continue };
          // Registry keys are Workspace-relative, as in BlobService's normal
          // read/write/delete paths; the storage adapter requires the prefix.
          let storage_key = myoxus_application::ports::blob::BlobKey::parse(key)
            .map_err(|_| JobError::Permanent("workspace.cleanupBlobs invalid relative blob key".into()))?
            .storage_key(id);
          match self.blob_storage.delete_blob(&storage_key).await {
            Ok(()) => {
              deleted += 1;
              tracing::trace!(workspace_id, key, "deleted blob file for removed workspace");
            }
            Err(e) => {
              failed += 1;
              tracing::warn!(workspace_id, key, error = %e, "failed to delete blob file for removed workspace");
            }
          }
        }

        tracing::info!(workspace_id, total, deleted, failed, "workspace.cleanupBlobs completed");
        if failed > 0 {
          // Partial failure: retryable so the job can be reattempted for the orphaned files.
          // However since we don't track which keys succeeded, the full list will be retried.
          // delete_blob is idempotent (silently succeeds for missing objects), so this is safe.
          return Err(JobError::Retryable(format!(
            "workspace.cleanupBlobs: {failed}/{total} blob deletions failed, will retry"
          )));
        }

        Ok(Some(
          serde_json::json!({ "deleted": deleted, "failed": failed, "total": total }),
        ))
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown workspace job type, skipping");
        Ok(None)
      }
    }
  }
}

/// Copilot queue handler.
///
/// Handles:
/// - `"copilot.generateTitle"` — generate a title for a copilot session
/// - `"copilot.cleanExpiredSessions"` — delete soft-deleted sessions older than 30 days
/// - `"copilot.generateEmbeddings"` — enqueue productive workspace source jobs
/// - `"copilot.session.deleteDoc"` — null out doc_id in sessions referencing a deleted doc
/// - `"copilot.session.cleanupEmptySessions"` — delete sessions with no messages older than 30 days
/// - `"copilot.session.generateMissingTitles"` — enqueue generateTitle for untitled sessions
/// - `"copilot.embedding.add"` — extract text from source, chunk, embed, store
/// - `"copilot.embedding.delete"` — delete embeddings for a source document
/// - `"copilot.embedding.refresh"` — delete + re-add embeddings for a source
/// - `"copilot.embedding.bulkIndex"` — enqueue embedding.add for all docs in a workspace
/// - `"copilot.embedding.cleanOrphans"` — remove embeddings for deleted sources
/// - `"copilot.transcript.generate"` — load audio blob, transcribe via the speech port, store result
/// - `"copilot.transcript.delete"` — delete canonical result content, retaining source audio
/// - `"copilot.transcript.refresh"` — replace the result only after successful recognition
/// - `"copilot.transcript.bulkProcess"` — enqueue generate for all audio blobs in a workspace
struct CopilotQueueHandler {
  copilot_service: Arc<CopilotService>,
  provider_registry: myoxus_application::copilot::provider::LlmProviderRegistry,
  transcription_state: ApiState,
  copilot_config: myoxus_api::config::CopilotConfig,
  default_model: Option<String>,
  queue: myoxus_worker::RedisQueue,
  embedding_repo: Arc<myoxus_infrastructure::copilot::embedding_store::SqlxCopilotEmbeddingRepository>,
  doc_service: Arc<DocService>,
  blob_service: Arc<myoxus_application::ports::blob_service::BlobService>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for CopilotQueueHandler {
  fn queue_name(&self) -> &str {
    "copilot"
  }

  async fn recover(&self, max_attempts: u32, dispatch_seconds: u32) -> Result<(), String> {
    self
      .transcription_state
      .context_ingestion()
      .await
      .map_err(|_| "context recovery unavailable".to_string())?
      .recover()
      .await
      .map_err(|_| "context recovery failed".to_string())?;
    self
      .transcription_state
      .transcription_pipeline()
      .map_err(|error| error.to_string())?
      .recover(myoxus_application::transcription::pipeline::TranscriptionJobPolicy {
        max_attempts,
        dispatch_seconds,
      })
      .await
      .map_err(|error| error.to_string())
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "copilot", "processing copilot job");

    match job_name {
      "copilot.context.ingest" => {
        let input = serde_json::from_value(job.data.clone())
          .map_err(|_| JobError::Permanent("invalid context input identity".into()))?;
        self
          .transcription_state
          .context_ingestion()
          .await
          .map_err(|_| JobError::Retryable("context worker unavailable".into()))?
          .execute(input)
          .await
          .map_err(|_| JobError::Retryable("context execution failed".into()))?;
        Ok(None)
      }
      "copilot.generateTitle" => {
        use myoxus_application::copilot::provider::{LlmMessage, LlmProviderError, LlmRequest, LlmRole};
        use myoxus_domain::entities::CopilotMessageRole;

        // Generate a display title for a copilot session based on its messages.
        let session_id: uuid::Uuid = job.data["sessionId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("copilot.generateTitle missing sessionId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid sessionId: {s}")))
          })?;

        // 2. Fetch session — skip if already titled or not found.
        let session = match self.copilot_service.get_session(session_id).await {
          Ok(s) => s,
          Err(e) => {
            tracing::warn!(job_id = %job.id, %session_id, error = %e, "copilot.generateTitle: session not found, skipping");
            return Ok(None);
          }
        };
        if session.title.as_ref().is_some_and(|t| !t.trim().is_empty()) {
          tracing::debug!(job_id = %job.id, %session_id, "copilot.generateTitle: session already has a title, skipping");
          return Ok(None);
        }

        // 3. Fetch messages — skip if none.
        let messages = self
          .copilot_service
          .list_messages(session_id, 10, 0)
          .await
          .map_err(|e| JobError::Retryable(format!("failed to list messages: {e}")))?;
        if messages.is_empty() {
          tracing::debug!(job_id = %job.id, %session_id, "copilot.generateTitle: no messages, skipping");
          return Ok(None);
        }

        // 4. Check that providers are available.
        if self.provider_registry.provider_ids().is_empty() {
          tracing::warn!(job_id = %job.id, %session_id, "copilot.generateTitle: no AI providers configured, skipping");
          return Ok(None);
        }

        // 5. Format conversation as prompt.
        let mut conversation = String::new();
        for msg in &messages {
          let role_label = match msg.role {
            CopilotMessageRole::User => "User",
            CopilotMessageRole::Assistant => "Assistant",
            CopilotMessageRole::System => "System",
            CopilotMessageRole::Tool => "Tool",
          };
          let text = msg
            .content
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| msg.content.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| msg.content.to_string());
          conversation.push_str(&format!("{role_label}: {text}\n"));
        }

        let prompt = format!(
          "Based on the following conversation, generate a concise title (5-10 words, no quotes):\n\n{conversation}"
        );

        // 6. Build the LLM request.
        let model = self.default_model.clone().unwrap_or_else(|| "gpt-4o-mini".to_string());
        let llm_request = LlmRequest {
          reasoning: None,
          model,
          messages: vec![LlmMessage {
            role: LlmRole::User,
            content: prompt.into(),
            name: None,
            tool_call_id: None,
          }],
          temperature: Some(0.3),
          max_tokens: Some(30),
          tools: Vec::new(),
          metadata: serde_json::json!({}),
        };

        // 7. Call the provider registry.
        let result = self
          .provider_registry
          .complete_with_fallback(
            &llm_request,
            &self.copilot_config.default_provider,
            &self.copilot_config.fallback_providers,
          )
          .await;

        let (_provider_id, response) = match result {
          Ok(r) => r,
          Err(LlmProviderError::InvalidRequest(msg)) => {
            tracing::warn!(job_id = %job.id, %session_id, error = %msg, "copilot.generateTitle: permanent provider error");
            return Err(JobError::Permanent(format!("AI provider config error: {msg}")));
          }
          Err(
            LlmProviderError::Unavailable(msg) | LlmProviderError::RateLimited(msg) | LlmProviderError::Timeout(msg),
          ) => {
            tracing::warn!(job_id = %job.id, %session_id, error = %msg, "copilot.generateTitle: retryable provider error");
            return Err(JobError::Retryable(format!("AI provider error: {msg}")));
          }
          Err(LlmProviderError::Upstream(msg)) => {
            tracing::warn!(job_id = %job.id, %session_id, error = %msg, "copilot.generateTitle: upstream provider error");
            return Err(JobError::Permanent(format!("AI provider upstream error: {msg}")));
          }
          Err(error @ (LlmProviderError::ContextLimit | LlmProviderError::OutputTruncated)) => {
            return Err(JobError::Permanent(error.to_string()));
          }
        };

        // 8. Extract and clean the title.
        let raw_title = response.output_text.trim().to_string();
        if raw_title.is_empty() {
          tracing::warn!(job_id = %job.id, %session_id, "copilot.generateTitle: AI returned empty title, skipping");
          return Ok(None);
        }
        let generated_title = raw_title.trim_matches('"').trim_matches('\'').trim().to_string();

        tracing::info!(
          job_id = %job.id,
          %session_id,
          title = %generated_title,
          "copilot.generateTitle: updating session with AI-generated title"
        );

        // 9. Update the session title.
        self
          .copilot_service
          .update_session(session_id, Some(generated_title.clone()), None, None, None, None)
          .await
          .map_err(|e| JobError::Retryable(format!("failed to update session title: {e}")))?;

        Ok(Some(serde_json::json!({ "title": generated_title })))
      }

      "copilot.cleanExpiredSessions" => {
        let rows_affected = self
          .copilot_service
          .purge_deleted_sessions_before(chrono::Utc::now() - chrono::Duration::days(30))
          .await
          .map_err(|error| JobError::Retryable(format!("copilot.cleanExpiredSessions: {error}")))?;
        tracing::info!(job_id = %job.id, rows_affected, "copilot.cleanExpiredSessions: removed expired sessions");
        Ok(Some(serde_json::json!({ "rows_affected": rows_affected })))
      }

      "copilot.generateEmbeddings" => self.handle_embedding_bulk_index(job).await,

      // ── Session lifecycle jobs (P35-B-03) ──────────────────────────────
      "copilot.session.deleteDoc" => {
        // When a doc is deleted, null out doc_id in sessions that referenced it.
        let doc_id: uuid::Uuid = job.data["docId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("copilot.session.deleteDoc missing docId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("copilot.session.deleteDoc: invalid docId: {s}")))
          })?;

        let updated = self
          .copilot_service
          .clear_session_document(doc_id)
          .await
          .map_err(|error| JobError::Retryable(format!("copilot.session.deleteDoc: {error}")))?;
        tracing::info!(job_id = %job.id, %doc_id, updated, "copilot.session.deleteDoc: cleared doc_id references");
        Ok(Some(serde_json::json!({ "updated": updated })))
      }

      "copilot.session.cleanupEmptySessions" => {
        // Delete sessions with no messages that were created more than 30 days ago.
        let deleted = self
          .copilot_service
          .purge_empty_sessions_before(chrono::Utc::now() - chrono::Duration::days(30))
          .await
          .map_err(|error| JobError::Retryable(format!("copilot.session.cleanupEmptySessions: {error}")))?;
        tracing::info!(job_id = %job.id, deleted, "copilot.session.cleanupEmptySessions: removed empty stale sessions");
        Ok(Some(serde_json::json!({ "deleted": deleted })))
      }

      "copilot.session.generateMissingTitles" => {
        // Find sessions without titles that have at least one message, enqueue
        // generateTitle jobs for each (capped at 100 per run to avoid overload).
        let sessions = self
          .copilot_service
          .list_untitled_session_ids(100)
          .await
          .map_err(|error| JobError::Retryable(format!("copilot.session.generateMissingTitles: {error}")))?;

        let mut enqueued = 0u64;
        for session_id in &sessions {
          match self
            .queue
            .enqueue(
              "copilot",
              "copilot.generateTitle",
              serde_json::json!({ "sessionId": session_id.to_string() }),
              myoxus_worker::JobOptions::default(),
            )
            .await
          {
            Ok(_) => enqueued += 1,
            Err(e) => {
              tracing::warn!(job_id = %job.id, %session_id, error = %e, "copilot.session.generateMissingTitles: failed to enqueue generateTitle");
            }
          }
        }

        tracing::info!(job_id = %job.id, found = sessions.len(), enqueued, "copilot.session.generateMissingTitles: completed");
        Ok(Some(
          serde_json::json!({ "found": sessions.len(), "enqueued": enqueued }),
        ))
      }

      // ── P61-A: Embedding pipeline ─────────────────────────────────────
      "copilot.embedding.add" => self.handle_embedding_add(job).await,

      "copilot.embedding.delete" => self.handle_embedding_delete(job).await,

      "copilot.embedding.refresh" => {
        // Atomic source replacement retains the previous index on failure.
        self.handle_embedding_add(job).await
      }

      "copilot.embedding.bulkIndex" => self.handle_embedding_bulk_index(job).await,

      "copilot.embedding.cleanOrphans" => self.handle_embedding_clean_orphans(job).await,

      // ── P70-C: Transcript pipeline (Whisper API) ─────────────────────
      "copilot.transcript.generate" => self.handle_transcript_job(job, "generate").await,

      "copilot.transcript.delete" => self.handle_transcript_job(job, "delete").await,

      "copilot.transcript.refresh" => self.handle_transcript_job(job, "refresh").await,

      "copilot.transcript.bulkProcess" => self.handle_transcript_job(job, "bulkProcess").await,

      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown copilot job type, skipping");
        Ok(None)
      }
    }
  }
}

// ── Embedding + Transcript (P70-C) helper methods on CopilotQueueHandler ──
impl CopilotQueueHandler {
  /// Parse workspace_id, source_type, source_id from a job's JSON data.
  fn parse_embedding_job_data(
    job: &myoxus_worker::Job,
  ) -> Result<(uuid::Uuid, myoxus_domain::entities::CopilotEmbeddingSourceType, String), myoxus_worker::JobError> {
    use myoxus_worker::JobError;

    let workspace_id: uuid::Uuid = job.data["workspaceId"]
      .as_str()
      .ok_or_else(|| JobError::Permanent("missing workspaceId".into()))
      .and_then(|s| {
        s.parse()
          .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
      })?;

    let source_type_str = job.data["sourceType"].as_str().unwrap_or("doc");
    let source_type = myoxus_domain::entities::CopilotEmbeddingSourceType::parse_or_doc(source_type_str);

    let source_id = job.data["sourceId"]
      .as_str()
      .ok_or_else(|| JobError::Permanent("missing sourceId".into()))?
      .to_string();

    Ok((workspace_id, source_type, source_id))
  }

  /// copilot.embedding.add — extract text from source, chunk, embed, store.
  async fn handle_embedding_add(
    &self,
    job: &myoxus_worker::Job,
  ) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let indexer = self
      .transcription_state
      .embedding_indexer()
      .await
      .map_err(|_| JobError::Retryable("embedding indexer unavailable".into()))?;
    let id = if let Some(id) = job.data["copilotJobId"].as_str() {
      uuid::Uuid::parse_str(id).map_err(|_| JobError::Permanent("invalid embedding job identity".into()))?
    } else {
      // Existing scheduled source jobs keep their deployed payload contract;
      // record their intent in the same SQL job owner before executing it.
      let (workspace, kind, source) = Self::parse_embedding_job_data(job)?;
      let user = job.data["userId"]
        .as_str()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(|_| JobError::Permanent("invalid embedding job owner".into()))?;
      self
        .copilot_service
        .create_job(
          "copilot.embedding.add".into(),
          Some(workspace),
          user,
          serde_json::json!({"sourceId":source,"sourceType":kind.as_str(),"model":indexer.model}),
        )
        .await
        .map_err(|_| JobError::Retryable("embedding intent could not be saved".into()))?
        .id
    };
    let chunks = indexer
      .execute(id)
      .await
      .map_err(|_| JobError::Retryable("embedding execution failed".into()))?;
    Ok(Some(serde_json::json!({"copilotJobId":id,"chunks":chunks})))
  }

  /// copilot.embedding.delete — delete all embeddings for a source.
  async fn handle_embedding_delete(
    &self,
    job: &myoxus_worker::Job,
  ) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_domain::repositories::CopilotEmbeddingRepository;
    use myoxus_worker::JobError;

    let (workspace_id, source_type, source_id) = Self::parse_embedding_job_data(job)?;

    tracing::info!(
      job_id = %job.id, %workspace_id, source_type = source_type.as_str(), %source_id,
      "copilot.embedding.delete: starting"
    );

    let deleted = self
      .embedding_repo
      .delete_embeddings_by_source(workspace_id, &source_type, &source_id)
      .await
      .map_err(|e| {
        tracing::error!(job_id = %job.id, %source_id, error = %e, "copilot.embedding.delete: failed");
        JobError::Retryable(format!("failed to delete embeddings: {e}"))
      })?;

    tracing::info!(
      job_id = %job.id, %workspace_id, %source_id, deleted,
      "copilot.embedding.delete: completed"
    );
    Ok(Some(serde_json::json!({ "deleted": deleted })))
  }

  /// copilot.embedding.bulkIndex — list all docs in workspace, enqueue add jobs.
  async fn handle_embedding_bulk_index(
    &self,
    job: &myoxus_worker::Job,
  ) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;

    let workspace_id: uuid::Uuid = job.data["workspaceId"]
      .as_str()
      .ok_or_else(|| JobError::Permanent("missing workspaceId".into()))
      .and_then(|s| {
        s.parse()
          .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
      })?;

    tracing::info!(job_id = %job.id, %workspace_id, "copilot.embedding.bulkIndex: starting");

    let docs = self
      .doc_service
      .list_content_docs_in_workspace(workspace_id, i64::MAX)
      .await
      .map_err(|error| {
        tracing::error!(job_id = %job.id, %error, "copilot.embedding.bulkIndex: failed to list docs");
        JobError::Retryable(format!("failed to list docs: {error}"))
      })?;

    let mut enqueued = 0_usize;
    let indexer = self
      .transcription_state
      .embedding_indexer()
      .await
      .map_err(|_| JobError::Retryable("embedding indexer unavailable".into()))?;
    let user = job.data["userId"]
      .as_str()
      .map(uuid::Uuid::parse_str)
      .transpose()
      .map_err(|_| JobError::Permanent("invalid embedding job owner".into()))?;
    let readable = if let Some(user) = user {
      Some(
        indexer
          .permissions
          .readable_doc_ids(user, workspace_id, &docs.iter().map(|doc| doc.id).collect::<Vec<_>>())
          .await
          .map_err(|_| JobError::Permanent("embedding source authorization unavailable".into()))?,
      )
    } else {
      None
    };
    for doc in &docs {
      if !myoxus_application::copilot::embedding::is_embedding_document(doc) {
        continue;
      }
      let doc_id = doc.id;
      if readable.as_ref().is_some_and(|ids| !ids.contains(&doc_id)) {
        continue;
      }
      indexer
        .queue_source(
          workspace_id,
          user,
          myoxus_domain::entities::CopilotEmbeddingSourceType::Doc,
          doc_id.to_string(),
        )
        .await
        .map_err(|_| JobError::Retryable("embedding source dispatch failed".into()))?;
      enqueued += 1;
    }

    tracing::info!(
      job_id = %job.id, %workspace_id, found = docs.len(), enqueued,
      "copilot.embedding.bulkIndex: completed"
    );
    Ok(Some(serde_json::json!({ "found": docs.len(), "enqueued": enqueued })))
  }

  /// copilot.embedding.cleanOrphans — remove embeddings for deleted sources.
  async fn handle_embedding_clean_orphans(
    &self,
    job: &myoxus_worker::Job,
  ) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_domain::repositories::CopilotEmbeddingRepository;
    use myoxus_worker::JobError;

    let workspace_id: uuid::Uuid = job.data["workspaceId"]
      .as_str()
      .ok_or_else(|| JobError::Permanent("missing workspaceId".into()))
      .and_then(|s| {
        s.parse()
          .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
      })?;

    tracing::info!(job_id = %job.id, %workspace_id, "copilot.embedding.cleanOrphans: starting");

    // 1. Get all distinct source_ids from copilot_embeddings for this workspace.
    let embedded_rows = self
      .embedding_repo
      .list_embedding_sources(workspace_id)
      .await
      .map_err(|error| JobError::Retryable(format!("failed to list embedded sources: {error}")))?;

    if embedded_rows.is_empty() {
      tracing::info!(job_id = %job.id, %workspace_id, "copilot.embedding.cleanOrphans: no embeddings found");
      return Ok(Some(serde_json::json!({ "cleaned": 0 })));
    }

    // 2. Check which source_ids still exist (docs in doc_snapshots, files in blobs).
    let mut valid_source_ids: Vec<String> = Vec::new();
    for (source_type_str, source_id_val) in &embedded_rows {
      let exists = match source_type_str.as_str() {
        "doc" => {
          if let Ok(doc_uuid) = uuid::Uuid::parse_str(source_id_val) {
            self
              .doc_service
              .get_metadata(doc_uuid)
              .await
              .map_err(|error| JobError::Retryable(format!("failed to check doc existence: {error}")))?
              .is_some_and(|doc| doc.workspace_id == Some(workspace_id))
          } else {
            false
          }
        }
        "file" | "attachment" => self
          .blob_service
          .get_blob_metadata(workspace_id, source_id_val)
          .await
          .map_err(|error| JobError::Retryable(format!("failed to check blob existence: {error}")))?
          .is_some_and(|blob| blob.deleted_at.is_none()),
        _ => false,
      };

      if exists {
        valid_source_ids.push(source_id_val.clone());
      }
    }

    // 3. Delete embeddings for missing sources.
    let deleted = self
      .embedding_repo
      .delete_orphan_embeddings(workspace_id, &valid_source_ids)
      .await
      .map_err(|e| {
        tracing::error!(job_id = %job.id, error = %e, "copilot.embedding.cleanOrphans: delete failed");
        JobError::Retryable(format!("failed to delete orphan embeddings: {e}"))
      })?;

    tracing::info!(
      job_id = %job.id, %workspace_id,
      total_embedded = embedded_rows.len(), valid = valid_source_ids.len(), deleted,
      "copilot.embedding.cleanOrphans: completed"
    );
    Ok(Some(
      serde_json::json!({ "cleaned": deleted, "total_checked": embedded_rows.len(), "still_valid": valid_source_ids.len() }),
    ))
  }

  async fn handle_transcript_job(
    &self,
    job: &myoxus_worker::Job,
    action: &str,
  ) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    self
      .transcription_state
      .transcription_pipeline()
      .map_err(|error| myoxus_worker::JobError::Retryable(error.to_string()))?
      .process_queued(
        action,
        &job.id,
        &job.data,
        self.transcription_state.transcription_service().await,
        self.transcription_state.transcription_job_policy(),
      )
      .await
      .map_err(|error| myoxus_worker::JobError::Retryable(error.to_string()))?;
    Ok(None)
  }
}

/// Indexer queue handler.
///
/// Routes `"indexer.indexDoc"`, `"indexer.deleteDoc"`, `"indexer.indexWorkspace"`,
/// `"indexer.deleteWorkspace"`, and `"indexer.autoIndexWorkspaces"` jobs to
/// `SearchIndexerService.process_payload()`.
struct IndexerQueueHandler {
  search_indexer: Arc<SearchIndexerService>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for IndexerQueueHandler {
  fn queue_name(&self) -> &str {
    "indexer"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_application::search::SearchIndexJobPayload;
    use myoxus_worker::JobError;

    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "indexer", "processing indexer job");

    let payload: SearchIndexJobPayload = match job_name {
      "indexer.indexDoc" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.indexDoc missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        let doc_id: uuid::Uuid = job.data["docId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.indexDoc missing docId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid docId: {s}")))
          })?;
        let kind = job.data["kind"].as_str().unwrap_or("snapshot");
        match kind {
          "snapshot" => SearchIndexJobPayload::Snapshot {
            workspace_id,
            doc_id,
            title: job.data["title"].as_str().unwrap_or("").to_string(),
            plain_text: job.data["plainText"].as_str().unwrap_or("").to_string(),
          },
          "delta" => SearchIndexJobPayload::Delta {
            workspace_id,
            doc_id,
            title: job.data["title"].as_str().map(str::to_string),
            append_plain_text: job.data["appendPlainText"].as_str().map(str::to_string),
            replace_plain_text: job.data["replacePlainText"].as_str().map(str::to_string),
          },
          "deferred" => SearchIndexJobPayload::DeferredSnapshot { workspace_id, doc_id },
          _ => SearchIndexJobPayload::DeferredSnapshot { workspace_id, doc_id },
        }
      }
      "indexer.autoIndexWorkspaces" => {
        // Cron-triggered jobs have no runId — skip gracefully (no active reindex).
        // Only jobs enqueued by start_full_reindex() / start_incremental_reindex()
        // carry a valid runId referencing an existing reindex_runs row.
        let run_id = match job.data["runId"].as_str().and_then(|s| s.parse::<uuid::Uuid>().ok()) {
          Some(id) => id,
          None => {
            tracing::debug!(job_id = %job.id, "autoIndexWorkspaces: no runId, skipping (cron poll)");
            return Ok(None);
          }
        };
        let batch_size = job.data["batchSize"].as_i64().unwrap_or(50);
        SearchIndexJobPayload::Reindex { run_id, batch_size }
      }
      "indexer.deleteDoc" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.deleteDoc missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        let doc_id: uuid::Uuid = job.data["docId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.deleteDoc missing docId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid docId: {s}")))
          })?;
        SearchIndexJobPayload::DeleteDoc { workspace_id, doc_id }
      }
      "indexer.indexWorkspace" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.indexWorkspace missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        SearchIndexJobPayload::IndexWorkspace { workspace_id }
      }
      "indexer.deleteWorkspace" => {
        let workspace_id: uuid::Uuid = job.data["workspaceId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("indexer.deleteWorkspace missing workspaceId".to_string()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid workspaceId: {s}")))
          })?;
        SearchIndexJobPayload::DeleteWorkspace { workspace_id }
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown indexer job type, skipping");
        return Ok(None);
      }
    };

    self.search_indexer.process_payload(payload).await.map_err(|e| {
      tracing::error!(job_id = %job.id, job_name, error = %e, "indexer job failed");
      JobError::Retryable(e.to_string())
    })?;
    Ok(None)
  }
}

// ─── Calendar Queue Handler ──────────────────────────────────────────────────

/// Processes `calendar.processReminder` and
/// `calendar.processPendingWrites` jobs.
///
/// - `calendar.processReminder`: marks a single reminder as delivered.
/// - `calendar.processPendingWrites`: retries deferred write-back operations
///   that failed when the remote server was unreachable.
struct CalendarQueueHandler {
  dispatcher: Arc<CalendarReminderDispatcher>,
  calendar_service: Arc<CalendarService>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for CalendarQueueHandler {
  fn queue_name(&self) -> &str {
    "calendar-reminder"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_application::calendar::ReminderDispatchPayload;
    use myoxus_worker::JobError;

    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "calendar-reminder", "processing calendar job");

    match job_name {
      "calendar.processReminder" => {
        let payload: ReminderDispatchPayload = serde_json::from_value(job.data.clone())
          .map_err(|e| JobError::Permanent(format!("invalid calendar.processReminder payload: {e}")))?;

        self
          .dispatcher
          .process_admitted_reminder(payload.reminder_id,payload.admission.as_ref())
          .await
          .map_err(|e| {
            tracing::warn!(job_id = %job.id, reminder_id = %payload.reminder_id, error = %e, "calendar reminder processing failed");
            JobError::Retryable(e.to_string())
          })?;
        Ok(None)
      }
      // P90-CAL-F-05: process deferred write-back operations.
      "calendar.processPendingWrites" => {
        let limit = job.data["limit"].as_i64().unwrap_or(50);
        let due = self
          .calendar_service
          .list_due_pending_writes(limit)
          .await
          .map_err(|e| {
            tracing::warn!(job_id = %job.id, error = %e, "calendar processPendingWrites: list_due failed");
            JobError::Retryable(e.to_string())
          })?;

        let mut processed = 0u32;
        let mut failed = 0u32;

        for write in due {
          let result = self.calendar_service.execute_pending_write(&write).await;

          match result {
            Ok(()) => {
              processed += 1;
            }
            Err(_error) => {
              tracing::warn!(
                write_id = %write.id,
                event_id = ?write.event_id,
                attempted_retry_count = write.retry_count + 1,
                "calendar pending write execution failed"
              );
              failed += 1;
            }
          }
        }

        tracing::info!(
          job_id = %job.id,
          processed,
          failed,
          "calendar.processPendingWrites completed"
        );
        Ok(Some(serde_json::json!({ "processed": processed, "failed": failed })))
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown calendar job type, skipping");
        Ok(None)
      }
    }
  }
}

// ─── CalDAV Sync Queue Handler ───────────────────────────────────────────────

/// Worker handler for the `caldav-sync` queue.
///
/// Handles the `caldav.syncAll` job: runs a full CalDAV pull-sync cycle for
/// all enabled CalDAV calendar accounts and upserts events into the local DB.
struct CalDavSyncQueueHandler {
  svc: Arc<myoxus_infrastructure::caldav::sync::CalDavSyncService>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for CalDavSyncQueueHandler {
  fn queue_name(&self) -> &str {
    "caldav-sync"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "caldav-sync", "processing CalDAV sync job");

    match job_name {
      "caldav.syncAll" => {
        let result = self
          .svc
          .run_sync()
          .await
          .map_err(|_| JobError::Retryable("CalDAV sync coordination unavailable".to_string()))?;
        tracing::info!(
          job_id = %job.id,
          accounts = result.accounts_processed,
          subscriptions = result.subscriptions_synced,
          events = result.events_upserted,
          errors = result.errors.len(),
          "caldav.syncAll completed"
        );
        if !result.errors.is_empty() {
          // Partial errors are non-fatal — log them but return success so
          // the job is not retried (errors are per-account, not global).
          for (account_id, msg) in &result.errors {
            tracing::warn!(job_id = %job.id, %account_id, error = %msg, "caldav.syncAll: per-account error");
          }
        }
        Ok(Some(serde_json::json!({
          "accounts_processed": result.accounts_processed,
          "subscriptions_synced": result.subscriptions_synced,
          "events_upserted": result.events_upserted,
          "error_count": result.errors.len(),
        })))
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown caldav-sync job type, skipping");
        Err(JobError::Permanent(format!("unknown caldav-sync job: {job_name}")))
      }
    }
  }
}

// ─── Google Calendar Sync Queue Handler ──────────────────────────────────────

/// Worker handler for the `google-calendar-sync` queue.
///
/// Handles:
/// - `googleCalendar.syncAll` — full/incremental pull-sync cycle for all accounts.
/// - `calendar.googleDeltaSync` — delta sync triggered by a webhook notification.
/// - `calendar.renewGoogleChannels` — renew expiring push-notification channels.
struct GoogleCalendarSyncQueueHandler {
  svc: Arc<myoxus_infrastructure::google_calendar::GoogleCalendarSyncService>,
  renewal_svc: Option<Arc<myoxus_infrastructure::google_calendar::GoogleChannelRenewalService>>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for GoogleCalendarSyncQueueHandler {
  fn queue_name(&self) -> &str {
    "google-calendar-sync"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "google-calendar-sync", "processing Google Calendar sync job");

    match job_name {
      "googleCalendar.syncAll" => {
        let result = self
          .svc
          .run_sync()
          .await
          .map_err(|_| JobError::Retryable("Google Calendar sync coordination unavailable".to_string()))?;
        tracing::info!(
          job_id = %job.id,
          accounts = result.accounts_processed,
          subscriptions = result.subscriptions_synced,
          events = result.events_upserted,
          incremental = result.incremental_syncs,
          full = result.full_syncs,
          errors = result.errors.len(),
          "googleCalendar.syncAll completed"
        );
        if !result.errors.is_empty() {
          for (account_id, msg) in &result.errors {
            tracing::warn!(job_id = %job.id, %account_id, error = %msg, "googleCalendar.syncAll: per-account error");
          }
        }
        Ok(Some(serde_json::json!({
          "accounts_processed": result.accounts_processed,
          "subscriptions_synced": result.subscriptions_synced,
          "events_upserted": result.events_upserted,
          "incremental_syncs": result.incremental_syncs,
          "full_syncs": result.full_syncs,
          "error_count": result.errors.len(),
        })))
      }
      "calendar.googleDeltaSync" => {
        // Webhook-triggered delta sync: run a full sync cycle (which will use
        // syncToken for incremental sync when available).
        tracing::info!(job_id = %job.id, "calendar.googleDeltaSync: running sync triggered by webhook");
        let result = self
          .svc
          .run_sync()
          .await
          .map_err(|_| JobError::Retryable("Google Calendar sync coordination unavailable".to_string()))?;
        tracing::info!(
          job_id = %job.id,
          events = result.events_upserted,
          errors = result.errors.len(),
          "calendar.googleDeltaSync completed"
        );
        Ok(Some(serde_json::json!({
          "events_upserted": result.events_upserted,
          "error_count": result.errors.len(),
        })))
      }
      "calendar.renewGoogleChannels" => {
        if let Some(renewal) = &self.renewal_svc {
          let result = renewal.run_renewal().await;
          tracing::info!(
            job_id = %job.id,
            checked = result.checked,
            renewed = result.renewed,
            errors = result.errors.len(),
            "calendar.renewGoogleChannels completed"
          );
          if !result.errors.is_empty() {
            for (sub_id, msg) in &result.errors {
              tracing::warn!(job_id = %job.id, %sub_id, error = %msg, "calendar.renewGoogleChannels: per-subscription error");
            }
          }
          Ok(Some(serde_json::json!({
            "checked": result.checked,
            "renewed": result.renewed,
            "error_count": result.errors.len(),
          })))
        } else {
          tracing::info!(job_id = %job.id, "calendar.renewGoogleChannels: no webhook_base_url configured, skipping renewal");
          Ok(Some(
            serde_json::json!({ "skipped": true, "reason": "no webhook_base_url" }),
          ))
        }
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown google-calendar-sync job type, skipping");
        Err(JobError::Permanent(format!(
          "unknown google-calendar-sync job: {job_name}"
        )))
      }
    }
  }
}

// ─── Git Sync Queue Handler ──────────────────────────────────────────────────

/// Worker handler for the `git-sync` queue.
///
/// Thin wrapper that delegates to `git_sync_engine::runner::run_sync` which
/// implements the full sync lifecycle in a structured, modular fashion.
struct GitSyncQueueHandler {
  pool: sqlx::PgPool,
  runner_config: myoxus_api::git_sync_engine::runner::RunnerConfig,
  locks: myoxus_api::git_sync_engine::locking::ProfileLocks,
  blob_storage: std::sync::Arc<dyn myoxus_application::ports::BlobStoragePort>,
  token_rotation: Arc<myoxus_application::git_sync::GitTokenRotationService>,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for GitSyncQueueHandler {
  fn queue_name(&self) -> &str {
    "git-sync"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_worker::JobError;

    let job_name = job.name.as_str();
    tracing::info!(job_id = %job.id, job_name, queue = "git-sync", "processing git-sync job");

    match job_name {
      "git-sync.tokenRotation" => {
        let profile_id: uuid::Uuid = job.data["profileId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("missing token-rotation profileId".into()))
          .and_then(|value| {
            value
              .parse()
              .map_err(|_| JobError::Permanent("invalid token-rotation profileId".into()))
          })?;
        let attempt_id: uuid::Uuid = job.data["attemptId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("missing token-rotation attemptId".into()))
          .and_then(|value| {
            value
              .parse()
              .map_err(|_| JobError::Permanent("invalid token-rotation attemptId".into()))
          })?;
        let current = self
          .token_rotation
          .status(profile_id)
          .await
          .map_err(|error| JobError::Retryable(error.to_string()))?
          .ok_or_else(|| JobError::Permanent("token-rotation state not found".into()))?;
        if current.latest_attempt_id != Some(attempt_id) {
          // A steward move or a later attempt makes this delivery obsolete. It
          // must neither request another token nor mark the newer attempt lost.
          return Ok(Some(serde_json::to_value(current).map_err(|_| {
            JobError::Permanent("token-rotation status could not be serialized".into())
          })?));
        }
        if job.attempts_made > 0 {
          if current.state != myoxus_application::git_sync::GitTokenRotationState::Rotating {
            return Ok(Some(serde_json::to_value(current).map_err(|_| {
              JobError::Permanent("token-rotation status could not be serialized".into())
            })?));
          }
          let status = self
            .token_rotation
            .mark_process_loss(profile_id, attempt_id, chrono::Utc::now())
            .await
            .map_err(|error| JobError::Retryable(error.to_string()))?;
          return Ok(Some(serde_json::to_value(status).map_err(|_| {
            JobError::Permanent("token-rotation status could not be serialized".into())
          })?));
        }
        match self
          .token_rotation
          .execute_attempt(profile_id, attempt_id, chrono::Utc::now())
          .await
        {
          Ok(status) => Ok(Some(serde_json::to_value(status).map_err(|_| {
            JobError::Permanent("token-rotation status could not be serialized".into())
          })?)),
          Err(error) => match self.token_rotation.status(profile_id).await {
            Ok(Some(status)) if status.state != myoxus_application::git_sync::GitTokenRotationState::Rotating => {
              Ok(Some(serde_json::to_value(status).map_err(|_| {
                JobError::Permanent("token-rotation status could not be serialized".into())
              })?))
            }
            Ok(_) | Err(_) => Err(JobError::Retryable(error.to_string())),
          },
        }
      }
      "git-sync.syncRun" => {
        let profile_id: uuid::Uuid = job.data["profileId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("missing profileId".into()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid profileId: {s}")))
          })?;
        let run_id: uuid::Uuid = job.data["runId"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("missing runId".into()))
          .and_then(|s| {
            s.parse()
              .map_err(|_| JobError::Permanent(format!("invalid runId: {s}")))
          })?;
        let direction = job.data["direction"]
          .as_str()
          .ok_or_else(|| JobError::Permanent("missing direction".into()))
          .and_then(|value| parse_git_sync_direction(value).map_err(|error| JobError::Permanent(error.to_string())))?;
        let trigger_source = match job.data["trigger"].as_str() {
          Some("Manual") => myoxus_domain::git_sync::GitSyncRunSource::Manual,
          Some("Polling") => myoxus_domain::git_sync::GitSyncRunSource::Polling,
          Some("Webhook") => myoxus_domain::git_sync::GitSyncRunSource::Webhook,
          Some("Cron") => myoxus_domain::git_sync::GitSyncRunSource::Cron,
          Some("HistoryCapture") => myoxus_domain::git_sync::GitSyncRunSource::HistoryCapture,
          Some(other) => return Err(JobError::Permanent(format!("invalid trigger source: {other}"))),
          None => return Err(JobError::Permanent("missing trigger source".into())),
        };

        // Delegate to the structured sync engine
        match myoxus_api::git_sync_engine::runner::run_sync(
          &self.pool,
          &self.runner_config,
          &self.locks,
          self.blob_storage.as_ref(),
          profile_id,
          run_id,
          &job.id,
          direction,
          trigger_source,
        )
        .await
        {
          Ok(result) => Ok(Some(result)),
          Err(e) => {
            if e.is_retryable() {
              Err(JobError::Retryable(e.to_string()))
            } else {
              Err(JobError::Permanent(e.to_string()))
            }
          }
        }
      }
      _ => {
        tracing::warn!(job_id = %job.id, job_name, "unknown git-sync job type, skipping");
        Ok(None)
      }
    }
  }

  async fn on_retry_exhausted(&self, job: &myoxus_worker::Job, message: &str) -> Result<(), String> {
    if job.name == "git-sync.tokenRotation" {
      let profile_id = job.data["profileId"]
        .as_str()
        .ok_or_else(|| "exhausted token-rotation job has no profileId".to_string())?
        .parse::<uuid::Uuid>()
        .map_err(|_| "exhausted token-rotation job has an invalid profileId".to_string())?;
      let attempt_id = job.data["attemptId"]
        .as_str()
        .ok_or_else(|| "exhausted token-rotation job has no attemptId".to_string())?
        .parse::<uuid::Uuid>()
        .map_err(|_| "exhausted token-rotation job has an invalid attemptId".to_string())?;
      let status = self
        .token_rotation
        .status(profile_id)
        .await
        .map_err(|error| format!("inspect exhausted token rotation: {error}"))?
        .ok_or_else(|| "exhausted token-rotation state not found".to_string())?;
      if status.latest_attempt_id != Some(attempt_id)
        || status.state != myoxus_application::git_sync::GitTokenRotationState::Rotating
      {
        return Ok(());
      }
      self
        .token_rotation
        .mark_process_loss(profile_id, attempt_id, chrono::Utc::now())
        .await
        .map_err(|error| format!("close exhausted token rotation: {error}"))?;
      return Ok(());
    }
    let run_id = job.data["runId"]
      .as_str()
      .ok_or_else(|| "exhausted Git-Sync job has no runId".to_string())?
      .parse::<uuid::Uuid>()
      .map_err(|error| format!("invalid exhausted Git-Sync runId: {error}"))?;
    let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(self.pool.clone());
    let terminal_message = format!("queue retry budget exhausted: {message}");
    match store
      .fail_pending_run_after_retry_exhaustion(run_id, &job.id, &terminal_message)
      .await
      .map_err(|error| format!("fail exhausted Git-Sync run {run_id}: {error}"))?
    {
      true => Ok(()),
      false => {
        let run = store
          .get_run(run_id)
          .await
          .map_err(|error| format!("inspect exhausted Git-Sync run {run_id}: {error}"))?;
        if matches!(
          run.status,
          myoxus_domain::git_sync::RunStatus::Completed
            | myoxus_domain::git_sync::RunStatus::Failed
            | myoxus_domain::git_sync::RunStatus::Cancelled
        ) {
          Ok(())
        } else {
          Err(format!(
            "exhausted Git-Sync run {run_id} remained {} or job identity changed",
            run.status
          ))
        }
      }
    }
  }
}

// ─── Outbox Processor ────────────────────────────────────────────────────────

/// Drain SQL document-change windows and existing outbox events. Only the
/// existing queued categories use Redis; change windows complete in PostgreSQL.
///
/// Runs a polling loop with ~1 second sleep between iterations.
/// Events are marked processed only after successful enqueue.
async fn run_outbox_processor(
  pool: sqlx::PgPool,
  redis_queue: myoxus_worker::RedisQueue,
  state: ApiState,
  workspace_content_repo: Arc<PgWorkspaceContentOperationRepository>,
  scheduling: Arc<myoxus_infrastructure::scheduling::PgSchedulingRepository>,
  mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
  tracing::info!("outbox processor started");
  let document_changes = myoxus_application::notification::document_change::DocumentChangeDispatcher::new(
    Arc::new(myoxus_infrastructure::notification::document_change::SqlxDocumentChangeStore::new(pool.clone())),
    state.auth().clone(),
    state.doc().clone(),
    state.permission_service(),
  );

  let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
  interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
  let scheduling_interval = std::time::Duration::from_secs(state.config.worker.cron_tick_interval_seconds);
  let mut next_scheduling = tokio::time::Instant::now();

  loop {
    tokio::select! {
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() { break; }
      }
      _ = interval.tick() => {
        // SQL completion precedes any Redis-dependent work. Fanout is only
        // an acceleration after commit and never contains document content.
        match document_changes.dispatch_due(chrono::Utc::now(), 50, &state.user_preference_defaults().await).await {
          Ok(notifications) => {
            for notification in notifications {
              myoxus_api::websocket::publish_user_notification(
                state.redis_ws_adapter().map(AsRef::as_ref), notification.user_id,
                "notification_new", serde_json::json!({"notificationId":notification.id}),
              ).await;
            }
          }
          Err(error) => tracing::warn!(error = %error, "document change batch drain failed"),
        }
        let publisher = myoxus_api::document_broadcast_outbox::SocketWorkspaceDocumentBroadcastPublisher::new(&state);
        if let Err(e) = myoxus_api::document_broadcast_outbox::process_workspace_doc_broadcast_batch(&pool, &publisher).await {
          tracing::warn!(error = %e, "workspace document broadcast outbox batch failed");
        }
        if let Err(e) = process_outbox_batch(&pool, &redis_queue, &state, &workspace_content_repo, &scheduling).await {
          tracing::warn!(error = %e, "outbox processor batch failed");
        }
        if tokio::time::Instant::now() >= next_scheduling {
          next_scheduling = tokio::time::Instant::now() + scheduling_interval;
          match tokio::time::timeout(std::time::Duration::from_millis(750), scheduling.dispatch_due(chrono::Utc::now(), 50)).await {
            Ok(Ok(report)) => tracing::debug!(admitted=report.admitted, blocked=report.blocked,
              raced=report.raced, budget_exhausted=report.budget_exhausted, "scheduled admission batch completed"),
            _ => tracing::warn!("scheduled admission batch unavailable; pending SQL slots retained"),
          }
        }
      }
    }
  }

  tracing::info!("outbox processor stopped");
}

/// Re-emit content-free wake-ups from authoritative nonterminal SQL state.
///
/// Wake-up loss or Redis downtime never changes operation semantics. A fresh
/// API process reconstructs the queue from PostgreSQL and duplicate deliveries
/// are absorbed by the worker's compare-and-transition contract.
async fn run_workspace_content_queue_reconciler(
  coordinator: Arc<WorkspaceContentClusterCoordinator>,
  mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
  const RECONCILE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);
  let mut interval = tokio::time::interval(RECONCILE_INTERVAL);
  interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
  loop {
    tokio::select! {
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() {
          break;
        }
      }
      _ = interval.tick() => {
        if let Err(error) = coordinator.reconcile(1_000).await {
          tracing::warn!(
            dependency = error.dependency(),
            "XWS queue reconciliation failed; durable operations remain recoverable"
          );
        }
      }
    }
  }
}

async fn process_outbox_batch(
  pool: &sqlx::PgPool,
  redis_queue: &myoxus_worker::RedisQueue,
  state: &ApiState,
  workspace_content_repo: &Arc<PgWorkspaceContentOperationRepository>,
  scheduling: &myoxus_infrastructure::scheduling::PgSchedulingRepository,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  use myoxus_application::workspace_content_operation::WorkspaceContentOperationRepository;
  use myoxus_domain::repositories::{OutboxRepository, PageRequest};

  if let Some(fanout) = state.redis_ws_adapter() {
    let dispatcher = WorkspaceContentNotificationDispatcher::new(
      workspace_content_repo.clone(),
      Arc::new(state.notification().clone()),
      fanout.clone(),
    );
    dispatcher.dispatch(50).await?;
  }

  let outbox = myoxus_infrastructure::outbox::SqlxOutboxRepository::new(pool.clone());
  let rows = outbox
    .list_unprocessed_non_document_broadcast_events(PageRequest { limit: 50, offset: 0 })
    .await?;

  if rows.is_empty() {
    return Ok(());
  }

  tracing::debug!(count = rows.len(), "outbox processor: processing batch");
  let recurrence_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(500);

  for row in rows {
    let event_id = row.id;
    let event_type = match row.event_type {
      myoxus_domain::entities::OutboxEventType::Mention => "mention",
      myoxus_domain::entities::OutboxEventType::Invite => "invite",
      myoxus_domain::entities::OutboxEventType::CommentReply => "comment_reply",
      myoxus_domain::entities::OutboxEventType::AccessChange => "access_change",
      myoxus_domain::entities::OutboxEventType::DocUpdated => "doc_updated",
      myoxus_domain::entities::OutboxEventType::WorkspaceDocBroadcast => "workspace_doc_broadcast",
      myoxus_domain::entities::OutboxEventType::WorkspaceContentPublished => "workspace_content_published",
      myoxus_domain::entities::OutboxEventType::HistoryCaptured => "history_captured",
      myoxus_domain::entities::OutboxEventType::CalendarMail => "calendar_mail",
      myoxus_domain::entities::OutboxEventType::DatabaseTaskNotification => "database_task_notification",
      myoxus_domain::entities::OutboxEventType::WorkspaceAutomationTrigger => "workspace_automation_trigger",
      myoxus_domain::entities::OutboxEventType::WorkspaceAutomationSignal => "workspace_automation_signal",
      myoxus_domain::entities::OutboxEventType::TaskRecurrenceDue => "task_recurrence_due",
      myoxus_domain::entities::OutboxEventType::CalendarReminderDue => "calendar_reminder_due",
      myoxus_domain::entities::OutboxEventType::DatabaseReminderDue => "database_reminder_due",
      myoxus_domain::entities::OutboxEventType::GitCronDue => "git_cron_due",
      myoxus_domain::entities::OutboxEventType::GitPollingDue => "git_polling_due",
      myoxus_domain::entities::OutboxEventType::GitRotationDue => "git_rotation_due",
      myoxus_domain::entities::OutboxEventType::RegisteredJobDue => "registered_job_due",
    };
    let payload = row.payload;

    let (job_name, job_data) = match event_type {
      "registered_job_due" => {
        let delivery: myoxus_domain::scheduling::registered::RegisteredDispatch = serde_json::from_value(payload)?;
        if !myoxus_infrastructure::scheduling::registered::delivery_is_current(pool, &delivery).await? {
          outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        } else {
          match redis_queue.enqueue_registered(&delivery).await {
            Ok(()) => outbox.mark_event_processed(event_id, chrono::Utc::now()).await?,
            Err(_) => tracing::warn!(%event_id,"registered worker queue handoff unavailable"),
          }
        }
        continue;
      }
      "git_rotation_due" => {
        let envelope: myoxus_domain::scheduling::GitRotationDispatch = serde_json::from_value(payload)?;
        match myoxus_api::git_sync_engine::scheduler::dispatch_rotation_intent(pool, redis_queue, &envelope).await {
          Ok(()) => outbox.mark_event_processed(event_id, chrono::Utc::now()).await?,
          Err(_) => tracing::warn!(%event_id,"native Git rotation handoff unavailable"),
        }
        continue;
      }
      "git_cron_due" | "git_polling_due" => {
        let envelope: myoxus_domain::scheduling::GitScheduleDispatch = serde_json::from_value(payload)?;
        let source = if event_type == "git_cron_due" {
          myoxus_domain::git_sync::GitSyncRunSource::Cron
        } else {
          myoxus_domain::git_sync::GitSyncRunSource::Polling
        };
        match myoxus_api::git_sync_engine::scheduler::dispatch_scheduled_intent(pool, redis_queue, &envelope, source)
          .await
        {
          Ok(()) => {
            outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
          }
          Err(_) => tracing::warn!(%event_id,"Scheduled Git queue handoff unavailable"),
        }
        continue;
      }
      "database_reminder_due" => {
        match myoxus_api::database_reminder_notification::enqueue_database_row_reminder_intent(
          pool,
          redis_queue,
          event_id,
          payload,
        )
        .await
        {
          Ok(()) => {
            outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
          }
          Err(_) => tracing::warn!(%event_id,"Database reminder queue handoff unavailable"),
        }
        continue;
      }
      "calendar_reminder_due" => {
        let admitted: myoxus_application::calendar::ReminderDispatchPayload = serde_json::from_value(payload)?;
        let fence = admitted
          .admission
          .as_ref()
          .ok_or("Calendar reminder outbox admission missing")?;
        match myoxus_infrastructure::scheduling::reminders::delivery_is_current(pool, admitted.reminder_id, fence).await
        {
          Ok(current) => {
            let result = if current {
              redis_queue
                .enqueue_idempotent(
                  "calendar-reminder",
                  &event_id.to_string(),
                  "calendar.processReminder",
                  serde_json::to_value(&admitted)?,
                  myoxus_worker::JobOptions {
                    max_attempts: 8,
                    ..Default::default()
                  },
                )
                .await
                .map(|_| ())
            } else {
              Ok(())
            };
            if result.is_ok() {
              outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
            } else {
              tracing::warn!(%event_id,"Calendar reminder queue handoff unavailable");
            }
          }
          Err(_) => tracing::warn!(%event_id,"Calendar reminder receipt read unavailable"),
        }
        continue;
      }
      "task_recurrence_due" => {
        // Leave excess wake-ups pending, but keep visiting ordinary categories.
        let remaining = recurrence_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
          continue;
        }
        if !matches!(
          tokio::time::timeout(
            remaining,
            myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(pool, scheduling, event_id)
          )
          .await,
          Ok(Ok(()))
        ) {
          tracing::warn!(%event_id, "native Task recurrence handoff unavailable");
        }
        continue;
      }
      "workspace_automation_signal" => {
        if let Some(service) = state.workspace_automation_service() {
          if myoxus_api::workspace_automation_worker::dispatch_committed_signal(pool, &service, event_id)
            .await
            .is_err()
          {
            tracing::warn!(%event_id, "workspace automation signal handoff failed");
          }
        }
        continue;
      }
      "workspace_automation_trigger" => {
        if let Some(service) = state.workspace_automation_service() {
          if myoxus_api::workspace_automation_worker::dispatch_committed_trigger(pool, &service, event_id)
            .await
            .is_err()
          {
            tracing::warn!(%event_id, "workspace automation trigger handoff failed");
          }
        }
        continue;
      }
      "database_task_notification" => {
        match myoxus_api::database_task_notification::enqueue(pool, redis_queue, event_id, &payload).await {
          Ok(()) => {
            if outbox.mark_event_processed(event_id, chrono::Utc::now()).await.is_err() {
              tracing::warn!(%event_id, "Task notification SQL handoff acknowledgement failed");
            }
          }
          Err(_) => tracing::warn!(%event_id, "Task notification queue handoff failed"),
        }
        continue;
      }
      "calendar_mail" => {
        let mut data = payload.clone();
        data["intentId"] = serde_json::json!(event_id);
        redis_queue
          .enqueue_idempotent(
            "notification",
            &format!("calendar-mail:{event_id}"),
            "notification.sendCalendarMail",
            data,
            myoxus_worker::JobOptions::default(),
          )
          .await?;
        outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        continue;
      }
      "invite" => {
        // Creating a shareable link has no recipient. Member invitations use
        // invitedUserId in the persisted outbox, whereas the worker uses userId.
        if payload.get("inviteLinkId").is_some() {
          outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
          continue;
        }
        let user_id = payload
          .get("invitedUserId")
          .or_else(|| payload.get("userId"))
          .and_then(serde_json::Value::as_str)
          .ok_or("invitation outbox recipient is missing")?
          .parse::<uuid::Uuid>()?;
        let workspace_id = payload
          .get("workspaceId")
          .and_then(serde_json::Value::as_str)
          .ok_or("invitation outbox workspace is missing")?
          .parse::<uuid::Uuid>()?;
        let Some(member) = state.workspace().get_member(workspace_id, user_id).await? else {
          // A revoked invitation must not become an actionable notification.
          outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
          continue;
        };
        if matches!(
          member.status,
          myoxus_domain::entities::MembershipStatus::Accepted | myoxus_domain::entities::MembershipStatus::Revoked
        ) {
          outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
          continue;
        }
        let workspace = state.workspace().get_workspace(workspace_id).await?;
        let inviter_id = payload
          .get("inviterId")
          .and_then(serde_json::Value::as_str)
          .ok_or("invitation outbox inviter is missing")?
          .parse::<uuid::Uuid>()?;
        let inviter = state.auth().get_user_by_id(inviter_id).await?;
        // The existing Inbox consumes these projections and the membership ID,
        // not only flat routing IDs. Resolve them for already-persisted events too.
        let job_data = serde_json::json!({
          "userId": user_id,
          "inviteId": member.invite_id,
          "inviterId": inviter_id,
          "workspaceId": workspace_id,
          "workspace": workspace.filter(|value| value.deleted_at.is_none()).map(|value| serde_json::json!({
            "id": value.id, "name": value.name,
          })),
          "createdByUser": inviter.map(|value| serde_json::json!({
            "name": value.name, "avatarUrl": value.avatar_url,
          })),
          "notificationType": "invitation",
        });
        ("notification.sendInvitation", job_data)
      }
      "mention" | "comment_reply" => {
        myoxus_api::comment_notification::enqueue_comment_notification(pool, redis_queue, state, &payload).await?;
        outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        continue;
      }
      "access_change" => {
        let action = payload["action"].as_str().unwrap_or_default();
        let workspace_id = payload["workspaceId"]
          .as_str()
          .ok_or("access change workspace missing")?
          .parse::<uuid::Uuid>()?;
        let mut deliveries = Vec::new();
        let user_id = payload["userId"]
          .as_str()
          .and_then(|value| value.parse::<uuid::Uuid>().ok());
        match action {
          "invite_accepted" | "invite_link_pending_accepted" => {
            if let Some(accepted_by) = user_id {
              let member = state.workspace().get_member(workspace_id, accepted_by).await?;
              let inviter = payload["inviterId"]
                .as_str()
                .and_then(|value| value.parse().ok())
                .or_else(|| member.as_ref().and_then(|member| member.invited_by_user_id));
              if let Some(inviter) = inviter {
                deliveries.push((inviter, "invitation_accepted", Some(accepted_by)));
              }
            }
          }
          "invite_link_joined_under_review" => {
            let mut offset = 0;
            loop {
              let members = state.workspace().list_members(workspace_id, offset, 100, None).await?;
              let count = members.len();
              for member in members {
                if member.status == myoxus_domain::entities::MembershipStatus::Accepted
                  && member.role >= myoxus_domain::entities::WorkspaceRole::Admin
                {
                  deliveries.push((member.user.id, "invitation_review_request", user_id));
                }
              }
              if count < 100 {
                break;
              }
              offset += 100;
            }
          }
          "admin_added" | "member_approved" | "member_revoked" | "member_role_updated" | "document_shared" => {
            if let Some(recipient) = user_id {
              let kind = match action {
                "admin_added" => "member_added",
                "member_approved" => "invitation_review_approved",
                "member_revoked" if payload["underReview"].as_bool() == Some(true) => "invitation_review_declined",
                "member_revoked" => "member_removed",
                "member_role_updated" => "role_changed",
                _ => "doc_shared",
              };
              let actor = payload["actorUserId"]
                .as_str()
                .or_else(|| payload["addedBy"].as_str())
                .and_then(|value| value.parse().ok());
              deliveries.push((recipient, kind, actor));
            }
          }
          "ownership_transferred" => {
            for key in ["previousOwnerId", "newOwnerId"] {
              if let Some(recipient) = payload[key].as_str().and_then(|value| value.parse().ok()) {
                deliveries.push((recipient, "role_changed", None));
              }
            }
          }
          _ => {}
        }
        for (recipient, kind, actor) in deliveries {
          let workspace = state.workspace().get_workspace(workspace_id).await?;
          let created_by = if let Some(actor) = actor {
            state.auth().get_user_by_id(actor).await?
          } else {
            None
          };
          let mut data = payload.clone();
          data["userId"] = serde_json::json!(recipient);
          data["reviewUserId"] = serde_json::json!(user_id);
          data["actorUserId"] = serde_json::json!(actor);
          data["notificationType"] = serde_json::json!(kind);
          data["idempotencyKey"] = serde_json::json!(format!("access-change:{event_id}:{recipient}"));
          data["workspace"] =
            serde_json::json!(workspace.map(|workspace| serde_json::json!({"id":workspace.id,"name":workspace.name})));
          data["createdByUser"] =
            serde_json::json!(created_by.map(|user| serde_json::json!({"name":user.name,"avatarUrl":user.avatar_url})));
          let key = data["idempotencyKey"].as_str().ok_or("access change key missing")?;
          redis_queue
            .enqueue_idempotent(
              "notification",
              key,
              "notification.sendAccessChange",
              data.clone(),
              myoxus_worker::JobOptions::default(),
            )
            .await?;
        }
        outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        continue;
      }
      "doc_updated" => {
        // Native lifecycle publication, including unopened template copies,
        // owns a durable search request independently of client sync pushes.
        let indexer = state.search_indexer().ok_or("document search indexer is unavailable")?;
        outbox
          .process_document_search_update(event_id, indexer.as_ref())
          .await?;
        continue;
      }
      "history_captured" => {
        let profile_id = payload
          .get("profileId")
          .and_then(serde_json::Value::as_str)
          .ok_or("history capture outbox profile id is missing")?
          .parse::<uuid::Uuid>()?;
        let history_id = payload
          .get("historyId")
          .and_then(serde_json::Value::as_i64)
          .ok_or("history capture outbox history id is missing")?;
        let generation = payload
          .get("activationGeneration")
          .and_then(serde_json::Value::as_i64)
          .ok_or("history capture outbox activation generation is missing")?;
        let policy = state.effective_git_sync_policy().await?.lifecycle_policy();
        let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool.clone());
        store
          .admit_history_capture(profile_id, history_id, generation, &policy)
          .await?;
        outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        continue;
      }
      "workspace_content_published" => {
        let operation_id = payload
          .get("operationId")
          .and_then(serde_json::Value::as_str)
          .ok_or("workspace content outbox operation id is missing")?
          .parse::<uuid::Uuid>()?;
        let workspace_id = payload
          .get("targetWorkspaceId")
          .and_then(serde_json::Value::as_str)
          .ok_or("workspace content outbox workspace id is missing")?
          .parse::<uuid::Uuid>()?;
        let resources: Vec<WorkspaceContentResourceRef> = serde_json::from_value(
          payload
            .get("resources")
            .cloned()
            .ok_or("workspace content outbox resources are missing")?,
        )?;
        let tag_ids = resources
          .iter()
          .filter(|resource| {
            resource.kind() == WorkspaceContentResourceKind::Tag && resource.workspace_id() == workspace_id
          })
          .map(|resource| resource.resource_id().parse::<uuid::Uuid>())
          .collect::<Result<Vec<_>, _>>()?;
        if !tag_ids.is_empty() {
          let tags = state
            .workspace_tag_service()
            .ok_or("workspace tag service is unavailable")?;
          if let Err(error) = tags.refresh_workspace_content_tags(workspace_id, &tag_ids).await {
            tracing::error!(%operation_id, phase = "post_commit", dependency_code = error.code,
              "workspace_content.tag_projection_pending");
            continue;
          }
        }
        let resource_count = i64::try_from(resources.len()).unwrap_or(i64::MAX);
        let coordinator = state
          .workspace_content_cluster_coordinator()
          .ok_or("workspace content cluster coordinator is unavailable")?;
        // Publication updates storage statistics outside the ordinary
        // DocStore/BlobStore write paths. The usage key is shared by all
        // instances, so deleting it once before the durable fanout prevents a
        // stale quota projection on every node.
        myoxus_infrastructure::quota_cache::QuotaCache::new(state.redis_port(), &state.config.redis.namespace)
          .invalidate_usage(workspace_id)
          .await;
        if let Some(source_workspace_id) = payload
          .get("sourceWorkspaceId")
          .and_then(serde_json::Value::as_str)
          .map(str::parse::<uuid::Uuid>)
          .transpose()?
        {
          // A moved directory/document invalidates both public workspace listings
          // and document artifacts. Link has no source-publication effect. Keep
          // this committed side effect retryable through the existing outbox.
          let mut public_projection_ready = true;
          for changed_workspace_id in [source_workspace_id, workspace_id] {
            if let Err(error) = state
              .public_repository()
              .invalidate_workspace(changed_workspace_id)
              .await
            {
              let (cause, error_kind) = match error {
                myoxus_application::public::PublicError::Repository(_) => {
                  (WorkspaceContentErrorCode::DatabaseUnavailable, "public_repository")
                }
                myoxus_application::public::PublicError::Render(_) => {
                  (WorkspaceContentErrorCode::EncodingFailed, "public_render")
                }
              };
              tracing::error!(%operation_id, phase = "post_commit", cause = cause.as_str(), error_kind,
                "workspace_content.public_projection_pending");
              public_projection_ready = false;
              break;
            }
          }
          if !public_projection_ready {
            continue;
          }
          let source_resources: Vec<WorkspaceContentResourceRef> = serde_json::from_value(
            payload
              .get("sourceResources")
              .cloned()
              .ok_or("workspace content source resources are missing")?,
          )?;
          let tag_ids = source_resources
            .iter()
            .filter(|resource| {
              resource.kind() == WorkspaceContentResourceKind::Tag && resource.workspace_id() == source_workspace_id
            })
            .map(|resource| resource.resource_id().parse::<uuid::Uuid>())
            .collect::<Result<Vec<_>, _>>()?;
          if !tag_ids.is_empty() {
            let tags = state
              .workspace_tag_service()
              .ok_or("workspace tag service is unavailable")?;
            if let Err(error) = tags.refresh_workspace_content_tags(source_workspace_id, &tag_ids).await {
              tracing::error!(%operation_id, phase = "post_commit", dependency_code = error.code,
                "workspace_content.tag_projection_pending");
              continue;
            }
          }
          if let Err(error) =
            cleanup_moved_source_blobs(pool, state.storage().as_ref(), source_workspace_id, &source_resources).await
          {
            tracing::warn!(
              event_id = %event_id,
              error = %error,
              "workspace content source Blob cleanup failed; event remains pending"
            );
            continue;
          }
          myoxus_infrastructure::quota_cache::QuotaCache::new(state.redis_port(), &state.config.redis.namespace)
            .invalidate_usage(source_workspace_id)
            .await;
          if let Err(error) = coordinator
            .publish_committed_change(
              WorkspaceContentRealtimeSignal {
                workspace_id: source_workspace_id,
                operation_id,
                status: WorkspaceContentOperationStatus::Succeeded,
              },
              source_resources,
            )
            .await
          {
            tracing::warn!(
              event_id = %event_id,
              error = %error,
              "workspace content source publication fanout failed; event remains pending"
            );
            continue;
          }
        }
        if let Err(error) = coordinator
          .publish_committed_change(
            WorkspaceContentRealtimeSignal {
              workspace_id,
              operation_id,
              status: WorkspaceContentOperationStatus::Succeeded,
            },
            resources,
          )
          .await
        {
          tracing::warn!(event_id = %event_id, error = %error, "workspace content publication fanout failed; event remains pending");
          continue;
        }
        if let Some(operation) = workspace_content_repo.get(operation_id).await?
          && operation.status == WorkspaceContentOperationStatus::Succeeded
        {
          state
            .audit_recorder()
            .record(
              myoxus_application::audit::AuditEvent::mutation(
                "workspace_content.succeeded",
                myoxus_application::audit::AuditCategory::Workspace,
                Some(myoxus_application::audit::AuditTarget::entity(
                  "workspace_content_operation",
                  operation_id,
                  None,
                )),
                myoxus_application::audit::AuditActor::user(operation.actor_id, None),
                None,
                Some(serde_json::json!({
                  "operationId": operation_id,
                  "operationKind": operation.kind.as_str(),
                  "sourceWorkspaceId": operation.source_workspace_id,
                  "targetWorkspaceId": operation.target_workspace_id,
                  "resourceCount": resource_count,
                  "status": "succeeded",
                })),
              )
              .with_metadata(serde_json::json!({
                "diagnosticInstanceId": operation.diagnostic_instance_id,
              })),
            )
            .await;
        }
        outbox.mark_event_processed(event_id, chrono::Utc::now()).await?;
        continue;
      }
      other => {
        tracing::debug!(event_id = %event_id, event_type = other, "outbox: unknown event type, skipping");
        if let Err(e) = outbox.mark_event_processed(event_id, chrono::Utc::now()).await {
          tracing::error!(event_id = %event_id, error = %e, "outbox: failed to mark event as processed — may be reprocessed");
        }
        continue;
      }
    };

    let opts = myoxus_worker::JobOptions::default();
    match redis_queue.enqueue("notification", job_name, job_data, opts).await {
      Ok(job_id) => {
        tracing::debug!(event_id = %event_id, %job_id, job_name, "outbox: enqueued notification job");
        if let Err(e) = outbox.mark_event_processed(event_id, chrono::Utc::now()).await {
          tracing::warn!(event_id = %event_id, error = %e, "outbox: failed to mark event processed");
        }
      }
      Err(e) => {
        tracing::warn!(event_id = %event_id, job_name, error = %e, "outbox: failed to enqueue job, will retry");
      }
    }
  }

  Ok(())
}

/// Drain historical source-delete events without deleting a live canonical Blob.
/// New transfers retain source catalogs/bytes and emit no such deletion intent.
async fn cleanup_moved_source_blobs(
  pool: &sqlx::PgPool,
  storage: &dyn BlobStoragePort,
  source_workspace_id: uuid::Uuid,
  source_resources: &[WorkspaceContentResourceRef],
) -> PortResult<()> {
  for resource in source_resources
    .iter()
    .filter(|resource| resource.kind() == WorkspaceContentResourceKind::Blob)
  {
    if resource.workspace_id() != source_workspace_id {
      return Err(PortError::InvalidInput(
        "workspace content source Blob belongs to a different workspace".to_string(),
      ));
    }
    let mut tx = pool
      .begin()
      .await
      .map_err(|_| PortError::Transport("canonical source Blob cleanup transaction failed".into()))?;
    let key = format!("{source_workspace_id}/{}", resource.resource_id());
    let unreferenced =
      myoxus_infrastructure::blob::SqlxBlobStore::lock_unreferenced_import_object_cleanup_in_tx(&mut tx, &key)
        .await
        .map_err(|_| PortError::Transport("canonical source Blob cleanup fence failed".into()))?;
    if unreferenced {
      storage.delete_blob(&key).await?;
    }
    tx.commit()
      .await
      .map_err(|_| PortError::Transport("canonical source Blob cleanup acknowledgement failed".into()))?;
  }
  Ok(())
}

// ─── Native Git intent recovery and delivery ────────────────────────────────

async fn run_git_sync_pending_dispatcher(
  pool: sqlx::PgPool,
  redis_queue: myoxus_worker::RedisQueue,
  runner_config: myoxus_api::git_sync_engine::runner::RunnerConfig,
  mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
  let store = myoxus_infrastructure::git_sync::SqlxGitSyncStore::new(pool);
  tracing::info!("git-sync pending dispatcher started");
  loop {
    tokio::select! {
      _ = shutdown.changed() => {
        if *shutdown.borrow() {
          tracing::info!("git-sync pending dispatcher shutting down");
          break;
        }
      }
      _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
        // History capture is durable data-driven intent, not a clock rule.
        // Recover receipts held behind busy Runs through this existing native
        // dispatcher, independently of the retired automatic timing branches.
        match runner_config.effective_policy().await {
          Ok(policy)=>if let Err(error)=store.drain_history_capture_intents(&policy.lifecycle_policy(),100).await{
            tracing::warn!(%error,"git-sync history intent recovery unavailable");
          },
          Err(_)=>tracing::warn!("git-sync history intent policy unavailable"),
        }
        match myoxus_api::git_sync_engine::dispatch::dispatch_pending_runs(&redis_queue, &store, 100).await {
          Ok(pass) if pass.attempted == 0 => {}
          Ok(pass) => {
            if !pass.failures.is_empty() {
              tracing::warn!(
                attempted = pass.attempted,
                acknowledged = pass.acknowledged,
                failures = ?pass.failures,
                "git-sync pending dispatch pass completed with isolated failures"
              );
            } else {
              tracing::debug!(
                attempted = pass.attempted,
                acknowledged = pass.acknowledged,
                "git-sync pending runs dispatched"
              );
            }
          }
          Err(error) => tracing::warn!(%error, "git-sync pending dispatch pass failed"),
        }
      }
    }
  }
}

fn parse_git_sync_direction(
  value: &str,
) -> Result<myoxus_domain::git_sync::SyncDirection, Box<dyn std::error::Error + Send + Sync>> {
  match value {
    "Bidirectional" => Ok(myoxus_domain::git_sync::SyncDirection::Bidirectional),
    "MyoxusToGit" => Ok(myoxus_domain::git_sync::SyncDirection::MyoxusToGit),
    "GitToMyoxus" => Ok(myoxus_domain::git_sync::SyncDirection::GitToMyoxus),
    other => Err(format!("invalid persisted Git-Sync direction: {other}").into()),
  }
}

/// Build the LLM provider registry from the copilot config section.
///
/// Iterates over all configured providers and instantiates the appropriate
/// `LlmProvider` implementation for each enabled entry.  Providers that fail
/// to initialise are logged at `warn` level and skipped -- the server still
/// starts but without that provider in the registry.
fn build_llm_provider_registry(config: &AppConfig) -> (LlmProviderRegistry, Option<String>) {
  use myoxus_api::config::CopilotProviderKind;

  let mut registry = LlmProviderRegistry::new();
  let mut default_model: Option<String> = None;

  for (id, provider_config) in &config.copilot.providers {
    if !provider_config.enabled {
      tracing::debug!(provider = %id, "copilot provider disabled, skipping");
      continue;
    }

    let Some(ref endpoint) = provider_config.endpoint else {
      tracing::warn!(provider = %id, "copilot provider enabled but no endpoint configured, skipping");
      continue;
    };

    // Resolve api_key: if prefixed with "env:", read from the environment.
    let api_key = provider_config
      .api_key
      .as_ref()
      .and_then(|key| {
        if let Some(env_var) = key.strip_prefix("env:") {
          std::env::var(env_var).ok()
        } else {
          Some(key.clone())
        }
      })
      .unwrap_or_default();
    let model = provider_config
      .models
      .first()
      .cloned()
      .unwrap_or_else(|| "gpt-4.1".to_string());
    let timeout = std::time::Duration::from_millis(provider_config.timeout_ms);

    if id == &config.copilot.default_provider {
      default_model = Some(model.clone());
    }

    match provider_config.kind {
      CopilotProviderKind::OpenAi | CopilotProviderKind::Local | CopilotProviderKind::Custom => {
        // All three kinds use the OpenAI-compatible chat completions protocol.
        match OpenAiProvider::new(
          id.clone(),
          api_key,
          endpoint.clone(),
          model,
          provider_config.models.clone(),
          provider_config.model_options.clone(),
          timeout,
          config.additional_ca.as_ref(),
        ) {
          Ok(provider) => {
            tracing::info!(
              provider = %id,
              kind = ?provider_config.kind,
              endpoint = %endpoint,
              model_count = provider_config.models.len(),
              "registered copilot LLM provider"
            );
            registry.register(Arc::new(provider));
          }
          Err(e) => {
            tracing::warn!(
              provider = %id,
              error = %e,
              "failed to initialise copilot LLM provider, skipping"
            );
          }
        }
      }
    }
  }

  let ids = registry.provider_ids();
  if ids.is_empty() {
    tracing::info!("no copilot LLM providers registered (copilot AI features will be unavailable)");
  } else {
    tracing::info!(
      providers = ?ids,
      default = %config.copilot.default_provider,
      default_model = ?default_model,
      "copilot LLM provider registry ready"
    );
  }

  (registry, default_model)
}

// ─── Template Registry Queue Handler ─────────────────────────────────────────

/// Template registry queue handler (P40-B).
///
/// Handles:
/// - `"template-registry.reconcileAll"` — list workspaces with active policies,
///   enqueue a per-workspace reconcile job for each.
/// - `"template-registry.driftScan"` — list workspaces with instances,
///   enqueue a per-workspace drift scan job for each.
/// - `"template-registry.reconcileWorkspace"` — reconcile a single workspace
///   through the same application service used by Registry operations.
/// - `"template-registry.driftScanWorkspace"` — scan live document drift for a single workspace.
///
/// Reconciliation must not duplicate the service with placeholder-only writes.
/// Drift scans and direct reconciliation share the application service's live
/// document owner and conflict policy.
struct TemplateRegistryQueueHandler {
  registry: myoxus_application::template_registry::TemplateRegistryService,
  pool: sqlx::PgPool,
  queue: myoxus_worker::RedisQueue,
  config_overrides: Arc<tokio::sync::RwLock<myoxus_api::config_reload::ConfigOverrides>>,
  default_enabled: bool,
  default_drift_scan_enabled: bool,
}

#[async_trait::async_trait]
impl myoxus_worker::JobHandler for TemplateRegistryQueueHandler {
  fn queue_name(&self) -> &str {
    "template-registry"
  }

  async fn process(&self, job: &myoxus_worker::Job) -> Result<Option<serde_json::Value>, myoxus_worker::JobError> {
    use myoxus_application::template_registry::TemplateRegistryStore;
    use myoxus_worker::JobError;
    let job_name = job.name.as_str();

    // Runtime enabled check: skip processing if the feature was disabled
    // via admin settings (app_configs table).  This allows the cron jobs
    // and queue handler to be always registered while the feature is
    // toggled on/off without server restart.
    let (enabled, drift_scan_enabled) = {
      let overrides = self.config_overrides.read().await;
      (
        overrides
          .overrides
          .get("template_registry.enabled")
          .and_then(serde_json::Value::as_bool)
          .unwrap_or(self.default_enabled),
        overrides
          .overrides
          .get("template_registry.drift_scan_enabled")
          .and_then(serde_json::Value::as_bool)
          .unwrap_or(self.default_drift_scan_enabled),
      )
    };
    if !enabled {
      tracing::debug!(job_id = %job.id, job_name, "template-registry disabled at runtime, skipping job");
      return Ok(None);
    }

    tracing::info!(job_id = %job.id, job_name, queue = "template-registry", "processing template-registry job");

    let template_store: Arc<dyn TemplateRegistryStore> =
      Arc::new(myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore::new(self.pool.clone()));

    match job_name {
      "template-registry.reconcileAll" => {
        let pending_jobs = template_store
          .list_recoverable_workspace_reconcile_jobs(200)
          .await
          .map_err(|e| JobError::Permanent(format!("failed to list durable reconcile jobs: {e}")))?;
        let mut recovered_workspaces = std::collections::HashSet::new();
        for pending in pending_jobs {
          let workspace_id = pending.workspace_id.expect("store returns workspace jobs");
          if !recovered_workspaces.insert(workspace_id) {
            continue;
          }
          self
            .queue
            .enqueue(
              "template-registry",
              "template-registry.reconcileWorkspace",
              serde_json::json!({
                "workspaceId": workspace_id,
                "reconcileJobId": pending.id,
              }),
              myoxus_worker::JobOptions {
                max_attempts: 5,
                ..Default::default()
              },
            )
            .await
            .map_err(|e| JobError::Retryable(format!("failed to recover durable template delivery: {e}")))?;
        }
        // Fan-out: discover workspaces with active policies and enqueue
        // individual reconcileWorkspace jobs for each.
        let workspace_ids = template_store
          .list_distinct_policy_workspace_ids()
          .await
          .map_err(|e| JobError::Permanent(format!("failed to list policy workspace IDs: {e}")))?;

        tracing::info!(
          workspace_count = workspace_ids.len(),
          "template-registry.reconcileAll — enqueuing per-workspace jobs"
        );

        let mut enqueued = 0u64;
        for ws_id in &workspace_ids {
          if recovered_workspaces.contains(ws_id) {
            enqueued += 1;
            continue;
          }
          if let Err(e) = self
            .queue
            .enqueue(
              "template-registry",
              "template-registry.reconcileWorkspace",
              serde_json::json!({ "workspaceId": ws_id.to_string() }),
              myoxus_worker::JobOptions::default(),
            )
            .await
          {
            tracing::warn!(
              workspace_id = %ws_id,
              error = %e,
              "reconcileAll — failed to enqueue workspace reconcile job"
            );
          } else {
            enqueued += 1;
          }
        }

        tracing::info!(
          total = workspace_ids.len(),
          enqueued,
          "template-registry.reconcileAll completed"
        );
        Ok(Some(serde_json::json!({
          "workspaces": workspace_ids.len(),
          "enqueued": enqueued,
          "recovered": recovered_workspaces.len(),
        })))
      }

      "template-registry.driftScan" => {
        // Runtime check: skip if drift scanning is disabled via admin settings.
        if !drift_scan_enabled {
          tracing::debug!(job_id = %job.id, "driftScan disabled at runtime, skipping");
          return Ok(None);
        }

        // Fan-out: discover workspaces with instances and enqueue
        // individual driftScanWorkspace jobs for each.
        let workspace_ids = template_store
          .list_distinct_instance_workspace_ids()
          .await
          .map_err(|e| JobError::Permanent(format!("failed to list instance workspace IDs: {e}")))?;

        tracing::info!(
          workspace_count = workspace_ids.len(),
          "template-registry.driftScan — enqueuing per-workspace jobs"
        );

        let mut enqueued = 0u64;
        for ws_id in &workspace_ids {
          if let Err(e) = self
            .queue
            .enqueue(
              "template-registry",
              "template-registry.driftScanWorkspace",
              serde_json::json!({ "workspaceId": ws_id.to_string() }),
              myoxus_worker::JobOptions::default(),
            )
            .await
          {
            tracing::warn!(
              workspace_id = %ws_id,
              error = %e,
              "driftScan — failed to enqueue workspace drift scan job"
            );
          } else {
            enqueued += 1;
          }
        }

        tracing::info!(
          total = workspace_ids.len(),
          enqueued,
          "template-registry.driftScan completed"
        );
        Ok(Some(serde_json::json!({
          "workspaces": workspace_ids.len(),
          "enqueued": enqueued,
        })))
      }

      "template-registry.reconcileWorkspace" => {
        let workspace_id = job
          .data
          .get("workspaceId")
          .and_then(|value| value.as_str())
          .ok_or_else(|| JobError::Permanent("missing workspaceId".into()))?
          .parse::<uuid::Uuid>()
          .map_err(|_| JobError::Permanent("invalid workspaceId".into()))?;
        let reconcile_job_id = job
          .data
          .get("reconcileJobId")
          .map(|value| {
            value
              .as_str()
              .ok_or_else(|| JobError::Permanent("invalid reconcileJobId".into()))?
              .parse::<uuid::Uuid>()
              .map_err(|_| JobError::Permanent("invalid reconcileJobId".into()))
          })
          .transpose()?;
        // Serialize this workspace across worker processes, including retries of
        // old placeholder rows. The transaction owns only the advisory lock;
        // document lifecycle transactions remain with their existing owner.
        let mut lease = self
          .pool
          .begin()
          .await
          .map_err(|_| JobError::Retryable("template lock unavailable".into()))?;
        let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))")
          .bind(format!("template-reconcile:{workspace_id}"))
          .fetch_one(&mut *lease)
          .await
          .map_err(|_| JobError::Retryable("template lock failed".into()))?;
        if !locked {
          return Err(JobError::Retryable(
            "workspace template reconciliation already running".into(),
          ));
        }
        // Read and transition durable state only after taking the workspace
        // lease. A duplicate queue delivery can otherwise observe Pending
        // before the first delivery completes and repeat materialization.
        let mut durable_job = if let Some(job_id) = reconcile_job_id {
          Some(
            template_store
              .get_reconcile_job(job_id)
              .await
              .map_err(|error| JobError::Retryable(format!("durable reconcile job unavailable: {error}")))?
              .ok_or_else(|| JobError::Permanent("durable reconcile job not found".into()))?,
          )
        } else {
          None
        };
        if let Some(durable) = durable_job.as_mut() {
          if durable.scope != myoxus_domain::template_registry::ReconcileScope::Workspace
            || durable.workspace_id != Some(workspace_id)
          {
            return Err(JobError::Permanent(
              "durable reconcile job does not match workspace payload".into(),
            ));
          }
          if durable.state == myoxus_domain::template_registry::JobState::Completed {
            return Ok(Some(serde_json::json!({
              "workspaceId": workspace_id,
              "delivery": "already-completed",
            })));
          }
          durable.state = myoxus_domain::template_registry::JobState::Running;
          durable.summary = Some(serde_json::json!({ "delivery": "running" }));
          durable.finished_at = None;
          template_store
            .update_reconcile_job(durable)
            .await
            .map_err(|error| JobError::Retryable(format!("durable reconcile job update failed: {error}")))?;
        }
        // The existing application operation owns release defaults, updates,
        // withdrawal and compensation; the handler only drives durable delivery.
        let instances = match self.registry.reconcile_workspace_templates(workspace_id).await {
          Ok(instances) => instances,
          Err(error) => {
            if let Some(durable) = durable_job.as_mut() {
              durable.state = myoxus_domain::template_registry::JobState::Pending;
              durable.summary = Some(serde_json::json!({
                "delivery": "pending",
                "error": "reconcile_failed",
              }));
              let _ = template_store.update_reconcile_job(durable).await;
            }
            return Err(JobError::Retryable(format!("template reconciliation failed: {error}")));
          }
        };
        if instances
          .iter()
          .any(|instance| instance.state == myoxus_domain::template_registry::InstanceState::Error)
        {
          if let Some(durable) = durable_job.as_mut() {
            durable.state = myoxus_domain::template_registry::JobState::Pending;
            durable.summary = Some(serde_json::json!({
              "delivery": "pending",
              "error": "materialization_failed",
            }));
            let _ = template_store.update_reconcile_job(durable).await;
          }
          return Err(JobError::Retryable(
            "template materialization failed; inspect instance diagnostics".into(),
          ));
        }
        if let Some(durable) = durable_job.as_mut() {
          durable.state = myoxus_domain::template_registry::JobState::Completed;
          durable.summary = Some(serde_json::json!({
            "delivery": "completed",
            "instances": instances.len(),
          }));
          durable.finished_at = Some(chrono::Utc::now());
          template_store
            .update_reconcile_job(durable)
            .await
            .map_err(|error| JobError::Retryable(format!("durable reconcile completion failed: {error}")))?;
        }
        Ok(Some(
          serde_json::json!({ "workspaceId": workspace_id, "instances": instances.len() }),
        ))
      }

      "template-registry.driftScanWorkspace" => {
        let workspace_id_str = job
          .data
          .get("workspaceId")
          .and_then(|v| v.as_str())
          .ok_or_else(|| JobError::Permanent("missing workspaceId in job data".to_string()))?;

        let workspace_id: uuid::Uuid = workspace_id_str
          .parse()
          .map_err(|e| JobError::Permanent(format!("invalid workspaceId: {e}")))?;

        let drifted = self
          .registry
          .scan_drift(workspace_id)
          .await
          .map_err(|error| JobError::Retryable(format!("live template drift scan failed: {error}")))?;

        tracing::info!(
          workspace_id = %workspace_id,
          drifted = drifted.len(),
          "template-registry.driftScanWorkspace completed"
        );
        Ok(Some(serde_json::json!({
          "workspaceId": workspace_id.to_string(),
          "drifted": drifted.len(),
        })))
      }

      other => {
        tracing::warn!(job_name = other, "unknown template-registry job name");
        Err(JobError::Permanent(format!("unknown job name: {other}")))
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use bytes::Bytes;
  use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest, PortError};
  use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
  use myoxus_infrastructure::storage::StorageAdapter;
  use uuid::Uuid;

  use super::{CopilotQueueHandler, cleanup_moved_source_blobs};

  #[tokio::test]
  async fn legacy_move_source_cleanup_rejects_foreign_workspace() {
    let root = tempfile::tempdir().expect("temporary Blob storage");
    let storage = StorageAdapter::new_fs(root.path().to_str().expect("UTF-8 storage root")).expect("Blob storage");
    let source_workspace_id = Uuid::new_v4();
    let other_workspace_id = Uuid::new_v4();
    let blob_id = "move-source-blob";
    let source_key = format!("{source_workspace_id}/{blob_id}");
    let other_key = format!("{other_workspace_id}/{blob_id}");
    for key in [&source_key, &other_key] {
      storage
        .write_blob(BlobWriteRequest {
          key: key.clone(),
          content_type: Some("application/octet-stream".to_string()),
          body: Bytes::from_static(b"payload"),
        })
        .await
        .expect("seed Blob");
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
      .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
      .expect("lazy pool");
    let wrong_workspace_resource =
      WorkspaceContentResourceRef::new(other_workspace_id, WorkspaceContentResourceKind::Blob, blob_id)
        .expect("wrong-workspace Blob resource");
    assert!(matches!(
      cleanup_moved_source_blobs(&pool, &storage, source_workspace_id, &[wrong_workspace_resource]).await,
      Err(PortError::InvalidInput(_))
    ));
    assert!(
      storage.read_blob(&other_key).await.is_ok(),
      "a malformed outbox resource must not delete another workspace's object"
    );
  }
}
