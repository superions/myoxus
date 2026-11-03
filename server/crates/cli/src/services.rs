//! Service bootstrap — wires infrastructure stores into application services
//! for use by CLI subcommands.
//!
//! The CLI connects directly to PostgreSQL (no HTTP hop) through the same
//! application+infrastructure service layer used by the API server.

use std::path::PathBuf;
use std::sync::Arc;
use std::{collections::HashMap, collections::HashSet};

use anyhow::Context;
use myoxus_application::git_sync::{GitSyncLifecyclePolicy, HttpsCertificatePolicy, SshHostKeyPolicy};
use myoxus_application::{
  admin::{AdminService, AdminUserService},
  auth::{AuthError, AuthService, DEFAULT_PASSWORD_RESET_TTL_SECONDS, PasswordPolicy, StaticPasswordPolicyProvider},
  doc::DocService,
  worker::WorkQueuePort,
  workspace::WorkspaceService,
  workspace_export::ObsidianVaultExportService,
  workspace_import::{WorkspaceImportPolicyProvider, WorkspaceImportRepository, WorkspaceImportService},
};
use myoxus_application::{
  audit::AuditRecorder,
  database::{DatabaseLimits, DatabaseMutationEffects, DatabaseServiceDependencies, DatabaseServices},
  document_graph::{DocumentGraphLimits, DocumentGraphService},
  document_metadata::DocumentMetadataService,
  organization::{OrganizationReadService, OrganizationUnitLifecycleService},
  permission::PermissionService,
  template_registry::{TemplateRegistryService, suggestions::TemplateSuggestionService},
  workspace_automation::{WorkspaceAutomationLimits, WorkspaceAutomationService},
};
use myoxus_contracts::runtime_config::load_server_config_sources;
use myoxus_domain::repositories::DocumentMetadataPolicyRepository;
use myoxus_infrastructure::{
  admin::SqlxAdminStore,
  auth::SqlxAuthStore,
  doc::SqlxDocStore,
  document_graph::PgDocumentGraphRepository,
  document_metadata::PgDocumentMetadataRepository,
  document_metadata_policy::PgDocumentMetadataPolicyRepository,
  mail::LogMailAdapter,
  storage::{S3StorageConfig, StorageAdapter},
  template_registry::SqlxTemplateRegistryStore,
  workspace::SqlxWorkspaceStore,
  workspace_automation::PgWorkspaceAutomationRepository,
  workspace_database::PgDatabaseRepository,
  workspace_import::PgWorkspaceImportRepository,
};
use serde::Deserialize;
use sqlx::PgPool;

const DEFAULT_REDIS_PREFIX: &str = "myoxus:queue:bull";

struct CliDocumentTemplateAccount {
  auth: AuthService,
  defaults: myoxus_application::auth::UserPreferenceDefaults,
}

#[async_trait::async_trait]
impl myoxus_application::document_template::DocumentTemplateAccount for CliDocumentTemplateAccount {
  async fn effective_preferences(
    &self,
    actor: uuid::Uuid,
  ) -> Result<myoxus_application::auth::EffectiveUserPreferences, AuthError> {
    Ok(
      self
        .auth
        .get_user_preferences(actor)
        .await?
        .values
        .resolve(&self.defaults),
    )
  }

  async fn applying_actor(
    &self,
    actor: uuid::Uuid,
  ) -> Result<Option<myoxus_application::document_template::DocumentTemplateActor>, AuthError> {
    Ok(
      self
        .auth
        .get_user_by_id(actor)
        .await?
        .filter(|user| !user.disabled && user.registered)
        .map(|user| myoxus_application::document_template::DocumentTemplateActor {
          name: user.name,
          email: user.email,
        }),
    )
  }
}

#[derive(Clone, Deserialize)]
struct CliRuntimeConfig {
  server: CliServerConfig,
  templates: CliTemplatesConfig,
  doc: CliDocConfig,
  crypto: CliCryptoConfig,
  git_sync: CliGitSyncConfig,
  #[serde(default)]
  auth: CliAuthConfig,
  #[serde(default)]
  oauth: CliOAuthConfig,
  redis: CliRedisConfig,
  storage: CliStorageConfig,
  websocket: CliWebSocketConfig,
  databases: CliDatabasesConfig,
  #[serde(default)]
  workspace: CliWorkspaceConfig,
  #[serde(default)]
  workspace_automation: myoxus_api::config::WorkspaceAutomationConfig,
  #[serde(default)]
  i18n: CliI18nConfig,
}

#[derive(Clone, Deserialize)]
struct CliTemplatesConfig {
  root_dir: String,
}

#[derive(Clone, Deserialize)]
#[serde(default)]
struct CliI18nConfig {
  default_locale: String,
  default_currency: String,
}

impl Default for CliI18nConfig {
  fn default() -> Self {
    Self {
      default_locale: "en".to_string(),
      default_currency: myoxus_domain::database::default_database_currency_code(),
    }
  }
}

#[derive(Clone, Deserialize)]
struct CliDocConfig {
  #[serde(deserialize_with = "myoxus_contracts::effective_config::deserialize_doc_decoder_concurrency")]
  decoder_concurrency: usize,
}

#[derive(Clone, Deserialize)]
struct CliCryptoConfig {
  private_key: String,
}

#[derive(Clone, Deserialize)]
#[serde(default)]
struct CliGitSyncConfig {
  enabled: bool,
  allowed_directions: Vec<String>,
  allowed_auth_methods: Vec<String>,
  allowed_hosts: Vec<String>,
  default_branch: String,
  auto_sync_allowed: bool,
  webhook_allowed: bool,
  ssh_host_key_policy: SshHostKeyPolicy,
  https_certificate_policy: HttpsCertificatePolicy,
  network_timeout_secs: u64,
  local_timeout_secs: u64,
  clone_depth: u32,
}

impl Default for CliGitSyncConfig {
  fn default() -> Self {
    Self {
      enabled: true,
      allowed_directions: vec![
        "bidirectional".to_string(),
        "myoxus_to_git".to_string(),
        "git_to_myoxus".to_string(),
      ],
      allowed_auth_methods: vec![
        "https_token".to_string(),
        "https_password".to_string(),
        "ssh_key".to_string(),
      ],
      allowed_hosts: Vec::new(),
      default_branch: "main".to_string(),
      auto_sync_allowed: true,
      webhook_allowed: false,
      ssh_host_key_policy: SshHostKeyPolicy::AcceptNew,
      https_certificate_policy: HttpsCertificatePolicy::Strict,
      network_timeout_secs: 120,
      local_timeout_secs: 30,
      clone_depth: 1,
    }
  }
}

#[derive(Clone)]
pub struct CliGitSyncRuntime {
  pub lifecycle_policy: GitSyncLifecyclePolicy,
  pub default_branch: String,
  pub ssh_host_key_policy: SshHostKeyPolicy,
  pub https_certificate_policy: HttpsCertificatePolicy,
  pub network_timeout_secs: u64,
  pub local_timeout_secs: u64,
  pub clone_depth: u32,
  pub crypto_private_key: String,
  pub https_ca_bundle: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
}

impl CliRuntimeConfig {
  fn load() -> anyhow::Result<(Self, PathBuf)> {
    let sources = load_server_config_sources().context("load Myoxus server configuration sources")?;
    let root = sources
      .paths
      .writeback_path
      .as_deref()
      .and_then(std::path::Path::parent)
      .unwrap_or(sources.paths.base_path.as_path())
      .to_path_buf();
    let config = sources
      .config
      .try_deserialize()
      .context("deserialize CLI server configuration projection")?;
    Ok((config, root))
  }

  fn database_limits(&self) -> DatabaseLimits {
    DatabaseLimits {
      max_fields_per_database: self.databases.max_fields_per_database,
      max_views_per_database: self.databases.max_views_per_database,
      max_rows_per_page: self.databases.max_rows_per_page,
      max_cell_text_bytes: self.databases.max_cell_text_bytes,
      csv_max_bytes: self.databases.csv_max_bytes,
      csv_max_rows: self.databases.csv_max_rows,
      csv_max_columns: self.databases.csv_max_columns,
      csv_sample_rows_for_type_inference: self.databases.csv_sample_rows_for_type_inference,
      max_reminders_per_user_per_cell: self.databases.max_reminders_per_user_per_cell,
      max_reminder_offset_minutes: self.databases.max_reminder_offset_minutes,
      ..DatabaseLimits::default()
    }
  }
}

#[derive(Clone, Deserialize, Default)]
struct CliOAuthConfig {
  #[serde(default)]
  providers: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Deserialize)]
struct CliServerConfig {
  origin: String,
}

#[derive(Clone, Deserialize)]
struct CliAuthConfig {
  #[serde(default)]
  password_requirements: CliPasswordRequirementsConfig,
  #[serde(default = "default_password_reset_ttl_seconds")]
  password_reset_ttl_seconds: i64,
}

#[derive(Clone, Deserialize)]
#[serde(default)]
struct CliPasswordRequirementsConfig {
  min: usize,
  max: usize,
}

impl Default for CliPasswordRequirementsConfig {
  fn default() -> Self {
    Self {
      min: myoxus_application::auth::DEFAULT_PASSWORD_MIN_LENGTH,
      max: myoxus_application::auth::DEFAULT_PASSWORD_MAX_LENGTH,
    }
  }
}

impl Default for CliAuthConfig {
  fn default() -> Self {
    Self {
      password_requirements: CliPasswordRequirementsConfig::default(),
      password_reset_ttl_seconds: default_password_reset_ttl_seconds(),
    }
  }
}

const fn default_password_reset_ttl_seconds() -> i64 {
  DEFAULT_PASSWORD_RESET_TTL_SECONDS
}

#[derive(Clone, Deserialize)]
struct CliRedisConfig {
  url: Option<String>,
  namespace: String,
  #[serde(default)]
  roles: CliRedisRolesConfig,
  #[serde(default)]
  session_cache: CliRedisSessionCacheConfig,
}

impl CliRedisConfig {
  fn socket_url(&self) -> Option<String> {
    self.roles.socket.url.clone().or_else(|| self.url.clone())
  }

  fn socket_namespace(&self) -> String {
    self
      .roles
      .socket
      .namespace
      .clone()
      .unwrap_or_else(|| format!("{}:socket", self.namespace))
  }

  fn queue_url(&self) -> Option<String> {
    self.roles.queue.url.clone().or_else(|| self.url.clone())
  }

  fn queue_namespace(&self) -> String {
    self
      .roles
      .queue
      .namespace
      .clone()
      .unwrap_or_else(|| format!("{}:queue", self.namespace))
  }

  fn session_url(&self) -> Option<String> {
    self.roles.session.url.clone().or_else(|| self.url.clone())
  }

  fn session_namespace(&self) -> String {
    self
      .roles
      .session
      .namespace
      .clone()
      .unwrap_or_else(|| format!("{}:session", self.namespace))
  }
}

#[derive(Clone, Default, Deserialize)]
struct CliRedisRolesConfig {
  #[serde(default)]
  socket: CliRedisRoleConfig,
  #[serde(default)]
  cache: CliRedisRoleConfig,
  #[serde(default)]
  session: CliRedisRoleConfig,
  #[serde(default)]
  queue: CliRedisRoleConfig,
}

#[derive(Clone, Default, Deserialize)]
struct CliRedisRoleConfig {
  url: Option<String>,
  namespace: Option<String>,
}

#[derive(Clone, Deserialize)]
struct CliRedisSessionCacheConfig {
  #[serde(default = "default_session_cache_enabled")]
  enabled: bool,
  #[serde(default = "default_session_cache_ttl_seconds")]
  ttl_seconds: u64,
}

impl Default for CliRedisSessionCacheConfig {
  fn default() -> Self {
    Self {
      enabled: default_session_cache_enabled(),
      ttl_seconds: default_session_cache_ttl_seconds(),
    }
  }
}

const fn default_session_cache_enabled() -> bool {
  true
}

const fn default_session_cache_ttl_seconds() -> u64 {
  300
}

#[derive(Clone, Deserialize)]
struct CliStorageConfig {
  backend: String,
  bucket: Option<String>,
  endpoint: Option<String>,
  region: Option<String>,
  access_key: Option<String>,
  secret_key: Option<String>,
  root: Option<String>,
  prefix: Option<String>,
  max_upload_mb: u64,
  io_timeout_seconds: u64,
  s3_max_retries: usize,
  #[serde(default)]
  default_workspace_quota_mb: u64,
}

impl CliStorageConfig {
  fn max_upload_bytes(&self) -> u64 {
    self.max_upload_mb.saturating_mul(1_048_576)
  }
}

#[derive(Clone, Deserialize)]
struct CliWebSocketConfig {
  max_http_buffer_size_mb: u64,
}

impl CliWebSocketConfig {
  fn max_http_buffer_size(&self) -> u64 {
    self.max_http_buffer_size_mb.saturating_mul(1_048_576)
  }
}

#[derive(Clone, Deserialize)]
#[serde(default)]
struct CliDatabasesConfig {
  max_fields_per_database: usize,
  max_views_per_database: usize,
  max_rows_per_page: i64,
  max_cell_text_bytes: usize,
  csv_max_bytes: usize,
  csv_max_rows: usize,
  csv_max_columns: usize,
  csv_sample_rows_for_type_inference: usize,
  max_reminders_per_user_per_cell: usize,
  max_reminder_offset_minutes: i64,
}

impl Default for CliDatabasesConfig {
  fn default() -> Self {
    // The API accepts partial YAML/runtime overlays and fills omitted values
    // from DatabaseLimits. The CLI must project the same contract instead of
    // making every operator command fail when a newer field is absent from an
    // otherwise valid deployment config.
    let limits = DatabaseLimits::default();
    Self {
      max_fields_per_database: limits.max_fields_per_database,
      max_views_per_database: limits.max_views_per_database,
      max_rows_per_page: limits.max_rows_per_page,
      max_cell_text_bytes: limits.max_cell_text_bytes,
      csv_max_bytes: limits.csv_max_bytes,
      csv_max_rows: limits.csv_max_rows,
      csv_max_columns: limits.csv_max_columns,
      csv_sample_rows_for_type_inference: limits.csv_sample_rows_for_type_inference,
      max_reminders_per_user_per_cell: limits.max_reminders_per_user_per_cell,
      max_reminder_offset_minutes: limits.max_reminder_offset_minutes,
    }
  }
}

#[derive(Clone, Default, Deserialize)]
struct CliWorkspaceConfig {
  #[serde(default, rename = "import")]
  r#import: myoxus_workspace_import::WorkspaceImportConfig,
}

struct CliWorkspaceImportPolicyProvider {
  policy: myoxus_application::workspace_import::WorkspaceImportPolicy,
}

#[async_trait::async_trait]
impl WorkspaceImportPolicyProvider for CliWorkspaceImportPolicyProvider {
  async fn current_policy(&self) -> myoxus_application::workspace_import::WorkspaceImportPolicy {
    self.policy
  }
}

/// Bundle of all application services used by CLI subcommands.
pub struct Services {
  /// Shared durable audit recorder for trusted local administration.
  pub audit: AuditRecorder,
  /// Admin service (list all users/workspaces, set admin flag).
  pub admin: AdminService,
  pub admin_users: AdminUserService,
  pub organization_unit_lifecycle: OrganizationUnitLifecycleService,
  pub organization_memberships: myoxus_application::organization::OrganizationMembershipService,
  pub organization_reads: OrganizationReadService,
  /// Auth service (create users, set passwords, delete accounts).
  pub auth: AuthService,
  /// Workspace service (create, get, delete workspaces, manage members).
  pub workspace: WorkspaceService,
  workspace_store: Arc<SqlxWorkspaceStore>,
  /// Doc service (compact-doc, load/push updates, trash sync).
  pub doc: DocService,
  /// Server-backed Workspace Database capability owners.
  pub databases: Arc<DatabaseServices>,
  pub assistant_packages: Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>,
  /// Document Graph service for read/reindex diagnostics.
  pub document_graph: DocumentGraphService,
  /// Canonical server-owned document metadata projection.
  pub document_metadata: Arc<DocumentMetadataService>,
  /// Template Registry service for catalog and row-template diagnostics.
  pub template_registry: Arc<TemplateRegistryService>,
  /// The same immutable release input admitted during service construction.
  pub feature_sources: myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet,
  /// Contextual Template Suggestions service.
  pub template_suggestions: TemplateSuggestionService,
  /// Workspace Automation service for final contract diagnostics.
  pub workspace_automation: Arc<WorkspaceAutomationService>,
  automation_runtime: Arc<myoxus_infrastructure::workflow_runtime::GlirulusWorkspaceAutomationRuntime>,
  /// Raw pool kept for operations that have no service equivalent
  /// (storage stats, migrations, worker queue metrics).
  pub pool: PgPool,
  pub html_catalog: Arc<dyn myoxus_public_render::HtmlRendererProvider>,
  runtime: CliRuntimeConfig,
  pub additional_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
  git_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
  database_limits: DatabaseLimits,
  workspace_tasks: myoxus_application::workspace::tasks::WorkspaceTasksInitializer,
  workspace_tag_repository: Arc<myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository>,
  config_overrides: HashMap<String, serde_json::Value>,
}

impl Services {
  /// Reuse the native Tag repository for trusted CLI read projections.
  pub fn workspace_tags(&self) -> Arc<myoxus_application::workspace_tags::WorkspaceTagService> {
    Arc::new(myoxus_application::workspace_tags::WorkspaceTagService::new(
      self.workspace_tag_repository.clone(),
      Arc::new(PermissionService::new(Arc::new(SqlxAuthStore::from_pool(
        self.pool.clone(),
      )))),
    ))
  }

  pub fn workspace_overviews(&self) -> myoxus_application::workspace_overview::WorkspaceOverviewService {
    myoxus_application::workspace_overview::WorkspaceOverviewService::new(
      self.workspace.clone(),
      self.doc.clone(),
      myoxus_application::document_metadata_policy::DocumentMetadataPolicyService::new(Arc::new(
        PgDocumentMetadataPolicyRepository::new(self.pool.clone()),
      )),
      self.workspace_tags(),
      self.auth.clone(),
    )
  }

  /// Configured public origin used for canonical document URLs in exports.
  pub fn server_origin(&self) -> &str {
    &self.runtime.server.origin
  }

  /// Resolve the server-owned locale used by non-interactive CLI renderers.
  pub fn default_locale(&self) -> String {
    self
      .config_overrides
      .get("i18n.default_locale")
      .and_then(serde_json::Value::as_str)
      .filter(|locale| !locale.trim().is_empty())
      .unwrap_or(&self.runtime.i18n.default_locale)
      .to_string()
  }

  /// Trusted local label maintenance uses the same configured cache role and
  /// key owner as the API. It creates no HTTP/session or synthetic admin actor.
  pub fn label_migration(
    &self,
  ) -> anyhow::Result<myoxus_application::workspace_tags::migration::LabelMigrationService> {
    let cache = if let Some(url) = self
      .runtime
      .redis
      .roles
      .cache
      .url
      .as_ref()
      .or(self.runtime.redis.url.as_ref())
    {
      let client =
        myoxus_infrastructure::tls::redis::client(url, self.additional_ca.as_ref()).map_err(anyhow::Error::msg)?;
      let namespace = self
        .runtime
        .redis
        .roles
        .cache
        .namespace
        .clone()
        .unwrap_or_else(|| format!("{}:cache", self.runtime.redis.namespace));
      let redis = Arc::new(myoxus_infrastructure::redis::RedisAdapter::from_client(
        client, namespace,
      ));
      Some(Arc::new(myoxus_infrastructure::doc_cache::DocCache::new(
        redis,
        "myoxus",
        &myoxus_infrastructure::doc_cache::RedisDocCacheConfig::default(),
      )) as Arc<dyn myoxus_application::doc::DocCachePort>)
    } else {
      None
    };
    Ok(
      myoxus_application::workspace_tags::migration::LabelMigrationService::new(
        self.workspace_tag_repository.clone(),
        cache,
      ),
    )
  }

  /// Runs before PostgreSQL; legacy DB trust is deliberately unavailable here.
  pub fn load_bootstrap_tls() -> anyhow::Result<(Option<myoxus_infrastructure::tls::ValidatedCaBundle>, bool)> {
    #[derive(Deserialize)]
    struct Bootstrap {
      #[serde(default)]
      tls: myoxus_contracts::runtime_config::TlsConfig,
    }
    let sources = load_server_config_sources()?;
    let root = sources
      .paths
      .writeback_path
      .as_deref()
      .and_then(std::path::Path::parent)
      .unwrap_or(sources.paths.base_path.as_path());
    let bootstrap: Bootstrap = sources.config.try_deserialize()?;
    let configured = bootstrap.tls.additional_ca_bundle_path.is_some();
    let bundle = myoxus_infrastructure::tls::load_bundle(
      root,
      bootstrap.tls.additional_ca_bundle_path.as_deref().unwrap_or_default(),
    )
    .map_err(anyhow::Error::msg)?;
    if let Some(bundle) = &bundle {
      myoxus_infrastructure::git_sync::ca_bundle::initialize(bundle).map_err(anyhow::Error::msg)?;
    }
    Ok((bundle, configured))
  }
  /// Build the server-configured object-store adapter used by CLI operations.
  ///
  /// Keeping this in the service bootstrap prevents recovery commands from
  /// accidentally reading the authentication-only temporary filesystem store.
  pub fn blob_storage(&self) -> anyhow::Result<Arc<dyn myoxus_application::ports::BlobStoragePort>> {
    configured_blob_storage_from(&self.runtime.storage, self.additional_ca.as_ref())
  }

  /// Load only file/environment configuration and construct the production
  /// blob adapter. Recovery commands use this path before candidate database
  /// migrations have canonicalized historical `app_configs` keys.
  pub fn configured_blob_storage(
    additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
  ) -> anyhow::Result<Arc<dyn myoxus_application::ports::BlobStoragePort>> {
    let (runtime, _) = CliRuntimeConfig::load()?;
    configured_blob_storage_from(&runtime.storage, additional_ca)
  }

  /// Use the same file/ENV default, persisted root override and packaged release
  /// expectation in both pre-migration recovery and the complete service graph.
  pub fn capture_feature_sources(
    root_override: Option<&serde_json::Value>,
  ) -> anyhow::Result<(
    PathBuf,
    myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet,
  )> {
    // Read-only preflight must not deserialize unrelated candidate settings.
    let sources = load_server_config_sources().context("load Myoxus server configuration sources")?;
    let templates: CliTemplatesConfig = sources.config.get("templates").context("load template source root")?;
    Self::capture_feature_sources_from(&templates.root_dir, root_override)
  }

  fn capture_feature_sources_from(
    configured_root: &str,
    root_override: Option<&serde_json::Value>,
  ) -> anyhow::Result<(
    PathBuf,
    myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet,
  )> {
    let root = match root_override {
      Some(value) => value.as_str().context("templates.root_dir must be a string")?,
      None => configured_root,
    };
    let configured = PathBuf::from(root);
    let root = if configured.is_absolute() {
      configured
    } else {
      std::env::current_dir()?.join(configured)
    };
    let captured = myoxus_infrastructure::feature_bundles::capture_feature_source_set(
      &root,
      &myoxus_infrastructure::feature_bundles::packaged_feature_release_manifest()?,
    )?;
    Ok((root, captured))
  }

  /// Construct all services from an already-connected pool.
  ///
  /// The CLI does not run an HTTP server, but feature commands still need the
  /// same application service graph as API/worker paths. Config-backed limits
  /// are loaded from `app_configs` here so CLI operations do not silently use a
  /// different Workspace Database contract.
  pub async fn from_pool(
    pool: PgPool,
    additional_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
    global_configured: bool,
  ) -> anyhow::Result<Self> {
    let (runtime, runtime_config_root) = CliRuntimeConfig::load()?;
    let config_overrides = myoxus_infrastructure::app_config::load_validated_app_config_values(&pool)
      .await
      .context("load validated runtime configuration overrides")?;
    let automation_limits = load_workspace_automation_limits(&config_overrides, &runtime.workspace_automation)?;
    let (template_root, feature_sources) =
      Self::capture_feature_sources_from(&runtime.templates.root_dir, config_overrides.get("templates.root_dir"))?;
    let database_starter_catalog = Arc::new(feature_sources.resolved.databases.clone());
    let assistant_catalog = Arc::new(feature_sources.resolved.assistants.clone());
    let html_catalog = Arc::new(myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(
      template_root.join("html"),
    ));
    let git_ca = if global_configured {
      additional_ca.clone()
    } else {
      if config_overrides.contains_key("git_sync.https_ca_bundle_path") {
        tracing::warn!("legacy Git-only CA configuration requires migration to tls.additional_ca_bundle_path");
      }
      let legacy_path = config_overrides
        .get("git_sync.https_ca_bundle_path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
      myoxus_infrastructure::git_sync::ca_bundle::materialize(&runtime_config_root, legacy_path)
        .map_err(anyhow::Error::msg)?
    };
    let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let workspace_store = Arc::new(SqlxWorkspaceStore::new(pool.clone(), database_starter_catalog.clone()));
    let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
    let doc_store = Arc::new(SqlxDocStore::new(pool.clone()).with_database_templates(database_starter_catalog.clone()));

    let mailer = Arc::new(LogMailAdapter);
    let auth_storage =
      Arc::new(StorageAdapter::new_fs("/tmp/myoxus-cli-storage").expect("StorageAdapter::new_fs must not fail"));

    let mut auth_service = AuthService::new_with_token_ttls(
      auth_store.clone(),
      mailer,
      auth_storage,
      // session_ttl_seconds and session_ttr_seconds: CLI never creates sessions,
      // but the constructor requires them.
      86_400, // 24 h TTL
      3_600,  // 1 h TTR
      1_800,
      resolve_password_reset_ttl_seconds(&config_overrides, runtime.auth.password_reset_ttl_seconds)?,
    )
    .context("validate CLI authentication token lifetimes")?
    .with_password_policy_provider(Arc::new(StaticPasswordPolicyProvider::new(resolve_password_policy(
      &config_overrides,
      &runtime.auth.password_requirements,
    )?)));
    if runtime.redis.session_cache.enabled {
      let session_url = runtime
        .redis
        .session_url()
        .context("Redis session role is required while session cache is enabled")?;
      let client =
        myoxus_infrastructure::tls::redis::client(&session_url, additional_ca.as_ref()).map_err(anyhow::Error::msg)?;
      let session_redis =
        myoxus_infrastructure::redis::RedisAdapter::from_client(client, runtime.redis.session_namespace());
      auth_service = auth_service.with_session_cache(Arc::new(session_redis), runtime.redis.session_cache.ttl_seconds);
    }

    let workspace_service = WorkspaceService::new(workspace_store.clone());
    let permission_service = Arc::new(PermissionService::new(auth_store.clone()));

    let admin_service = AdminService::new(admin_store);
    let decoder_concurrency = config_overrides
      .get("doc.decoder_concurrency")
      .map(|value| serde_json::from_value::<usize>(value.clone()))
      .transpose()
      .context("read configured document decoder capacity")?
      .unwrap_or(runtime.doc.decoder_concurrency);
    let doc_service =
      DocService::new_with_decoder_concurrency(doc_store, decoder_concurrency).map_err(anyhow::Error::msg)?;

    let document_metadata_repo = Arc::new(PgDocumentMetadataRepository::new(pool.clone()));
    let document_metadata_service = Arc::new(DocumentMetadataService::new(document_metadata_repo));
    let document_metadata_policy_repo: Arc<dyn DocumentMetadataPolicyRepository> =
      Arc::new(PgDocumentMetadataPolicyRepository::new(pool.clone()));
    let database_repo = Arc::new(PgDatabaseRepository::new(
      pool.clone(),
      database_starter_catalog.clone(),
    ));
    let document_graph = DocumentGraphService::new(
      Arc::new(PgDocumentGraphRepository::new(pool.clone())),
      Arc::new(doc_service.clone()),
      permission_service.clone(),
      document_metadata_service.clone(),
      Some(database_repo.clone()),
      Some(database_repo.clone()),
      None,
      DocumentGraphLimits::default(),
    );

    let database_limits = load_database_limits(&config_overrides, runtime.database_limits());
    // Template repair commands must resolve the same persisted bundles as the
    // API; the isolated auth adapter above is intentionally CLI-local.
    let template_blob_storage = configured_blob_storage_from(&runtime.storage, additional_ca.as_ref())?;
    let template_assets = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
      Arc::new(
        myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())
          .with_quota_config(runtime.storage.default_workspace_quota_mb),
      ),
      template_blob_storage.clone(),
      runtime.server.origin.clone(),
    ));
    let mut template_registry = TemplateRegistryService::new(Arc::new(SqlxTemplateRegistryStore::new(pool.clone())))
      .with_materialization(doc_service.clone(), template_blob_storage.clone())
      .with_asset_materialization(template_assets.clone());
    if let Some(url) = runtime.redis.socket_url() {
      let client =
        myoxus_infrastructure::tls::redis::client(&url, additional_ca.as_ref()).map_err(anyhow::Error::msg)?;
      let adapter = Arc::new(myoxus_infrastructure::redis::RedisAdapter::from_client(
        client,
        runtime.redis.socket_namespace(),
      ));
      template_registry = template_registry.with_builder_notifications(Arc::new(
        myoxus_infrastructure::redis::workspace_broadcast::RedisTemplateBuilderNotifications(adapter),
      ));
    }
    // Opening an operations service is read-only with respect to Registry
    // content. Server startup publishes the admitted release; explicit CLI
    // import/publication commands retain their native mutation boundary.
    let template_registry = Arc::new(template_registry);
    let workspace_service = workspace_service.with_template_registry(template_registry.as_ref().clone());
    let template_suggestions = TemplateSuggestionService::new(
      template_registry.clone(),
      Some(document_metadata_policy_repo.clone()),
      Some(permission_service.clone()),
    );

    let audit_recorder = AuditRecorder::new(Arc::new(myoxus_infrastructure::audit::PgAuditLogStore::new(
      pool.clone(),
    )));
    let database_effects = DatabaseMutationEffects::new(
      myoxus_application::database::activity::DatabaseActivityRecorder::noop(),
      Arc::new(audit_recorder.clone()),
      Arc::new(myoxus_application::database::DisabledDatabaseNotifications),
      Arc::new(myoxus_application::ports::database_change::NullDatabaseChangeNotification),
    );
    let databases = Arc::new(DatabaseServices::new(
      database_repo.clone(),
      doc_service.clone(),
      permission_service.clone(),
      database_limits.clone(),
      workspace_store.clone(),
      database_starter_catalog.clone(),
      DatabaseServiceDependencies::disabled()
        .with_effects(database_effects)
        .with_template_registry(template_registry.as_ref().clone()),
    ));

    doc_service
      .set_document_graph_index_hook(Arc::new(document_graph.clone()))
      .await;

    let organization_unit_lifecycle = OrganizationUnitLifecycleService::new(
      Arc::new(
        myoxus_infrastructure::organization::PgOrganizationUnitLifecycleRepository::new(
          pool.clone(),
          serde_json::Value::Object(runtime.oauth.providers.clone()),
        ),
      ),
      audit_recorder.clone(),
    );
    let membership_cache = if let Some(url) = runtime.redis.roles.cache.url.as_ref().or(runtime.redis.url.as_ref()) {
      let client =
        myoxus_infrastructure::tls::redis::client(url, additional_ca.as_ref()).map_err(anyhow::Error::msg)?;
      let namespace = runtime
        .redis
        .roles
        .cache
        .namespace
        .clone()
        .unwrap_or_else(|| format!("{}:cache", runtime.redis.namespace));
      Some(Arc::new(myoxus_infrastructure::redis::RedisAdapter::from_client(
        client, namespace,
      )))
    } else {
      None
    };
    auth_service = auth_service.with_session_revocation_effects(Arc::new(
      myoxus_infrastructure::cache_invalidation::RedisSessionRevocationEffects::new(
        membership_cache.clone(),
        uuid::Uuid::new_v4(),
      ),
    ));
    let organization_memberships = myoxus_application::organization::OrganizationMembershipService::new(
      Arc::new(myoxus_infrastructure::organization::PgOrganizationMembershipWriter::new(pool.clone())),
      Arc::new(myoxus_infrastructure::cache_invalidation::RedisMembershipEffects::new(
        membership_cache,
      )),
      audit_recorder.clone(),
    );
    let organization_reads = OrganizationReadService::new(
      Arc::new(myoxus_infrastructure::organization::PgOrganizationRepository::new(
        pool.clone(),
      )),
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitTypeRepository::new(pool.clone())),
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitRepository::new(
        pool.clone(),
      )),
      Arc::new(myoxus_infrastructure::organization::PgOrganizationUnitMemberRepository::new(pool.clone())),
      auth_service.clone(),
    );
    let workspace_tag_repository = Arc::new(myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository::new(
      pool.clone(),
      database_starter_catalog.clone(),
    ));
    let documents = Arc::new(
      myoxus_application::document_template::DocumentTemplateService::new(
        Arc::new(PgDocumentMetadataRepository::new(pool.clone())),
        Arc::new(doc_service.clone()),
        permission_service.clone(),
      )
      .with_mutation_ports(
        document_metadata_service.clone(),
        Arc::new(
          myoxus_application::document_template::OrganizerDocumentTemplatePlacement::new(
            doc_service.clone(),
            permission_service.clone(),
          ),
        ),
      )
      .with_instantiation_assets(template_assets)
      .with_workspace_context(workspace_service.clone())
      .with_account(Arc::new(CliDocumentTemplateAccount {
        auth: auth_service.clone(),
        defaults: myoxus_application::auth::UserPreferenceDefaults {
          locale: config_overrides
            .get("i18n.default_locale")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&runtime.i18n.default_locale)
            .to_string(),
          journal_first_day_of_week: config_overrides
            .get("journal.first_day_of_week")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("monday")
            .to_string(),
          journal_show_calendar_weeks: config_overrides
            .get("journal.show_calendar_weeks")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
          ..Default::default()
        },
      })),
    );
    let assistant_packages = Arc::new(
      myoxus_application::workspace::assistant_packages::AssistantPackageService::new(
        assistant_catalog,
        database_starter_catalog.clone(),
        databases.definition.clone(),
        databases.views.clone(),
        workspace_store.clone(),
        config_overrides
          .get("i18n.default_currency")
          .and_then(serde_json::Value::as_str)
          .unwrap_or(&runtime.i18n.default_currency)
          .to_string(),
        config_overrides
          .get("i18n.default_locale")
          .and_then(serde_json::Value::as_str)
          .unwrap_or(&runtime.i18n.default_locale)
          .to_string(),
      )
      .with_document_components(documents, template_registry.clone())
      .with_context_workflows_enabled(automation_limits.enabled),
    );
    let workspace_automation = WorkspaceAutomationService::new(
      Arc::new(
        PgWorkspaceAutomationRepository::new(pool.clone()).with_database_templates(database_starter_catalog.clone()),
      ),
      database_repo.clone(),
      database_repo.clone(),
      doc_service.clone(),
      permission_service.clone(),
      audit_recorder.clone(),
      None,
      None,
      automation_limits,
      databases.editing.clone(),
    )
    .with_context_documents(
      workspace_store.clone(),
      assistant_packages.clone(),
      Arc::new(auth_service.clone()),
    );
    let automation_runtime = Arc::new(
      myoxus_infrastructure::workflow_runtime::GlirulusWorkspaceAutomationRuntime::new(
        pool.clone(),
        workspace_automation.native_executor(),
      )
      .with_database_templates(database_starter_catalog.clone()),
    );
    let workspace_automation = Arc::new(workspace_automation.with_runtime(automation_runtime.clone()));

    let workspace_service = workspace_service.with_automation(workspace_automation.clone());

    let workspace_tasks = myoxus_application::workspace::tasks::WorkspaceTasksInitializer::new(
      database_starter_catalog,
      database_repo.clone(),
      databases.projection.clone(),
    );
    Ok(Self {
      audit: audit_recorder.clone(),
      organization_memberships,
      organization_reads,
      organization_unit_lifecycle,
      admin_users: AdminUserService::new(
        admin_service.clone(),
        auth_service.clone(),
        workspace_service.clone(),
        audit_recorder,
      ),
      admin: admin_service,
      auth: auth_service,
      workspace: workspace_service,
      workspace_store,
      doc: doc_service,
      databases,
      assistant_packages,
      document_graph,
      document_metadata: document_metadata_service,
      template_registry,
      feature_sources,
      template_suggestions,
      workspace_automation,
      automation_runtime,
      pool,
      runtime,
      html_catalog,
      additional_ca,
      git_ca,
      database_limits,
      workspace_tasks,
      workspace_tag_repository,
      config_overrides,
    })
  }

  pub async fn ensure_workspace_tasks(
    &self,
    workspace_id: uuid::Uuid,
  ) -> anyhow::Result<myoxus_domain::database::DatabaseRecord> {
    self
      .workspace_tasks
      .ensure(workspace_id, None)
      .await
      .map_err(Into::into)
  }

  pub async fn workspace_automation_with_queue(
    &self,
    redis_prefix: String,
  ) -> anyhow::Result<Arc<WorkspaceAutomationService>> {
    self.automation_runtime.readiness().await?;
    let queue = queue_adapter(redis_prefix, self.additional_ca.as_ref()).await?;
    Ok(Arc::new(self.workspace_automation.as_ref().clone().with_queue(queue)))
  }

  /// Resolve the same YAML/ENV baseline plus live DB overrides used by the API
  /// Git-Sync lifecycle. Secret material remains inside this service object and
  /// is never projected by CLI output types.
  pub async fn git_sync_runtime(&self) -> anyhow::Result<CliGitSyncRuntime> {
    use myoxus_domain::git_sync::{AuthMethod, SyncDirection};

    let value = |key: &str| self.config_overrides.get(key);
    let normalized_list = |key: &str, fallback: &[String]| {
      value(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
          items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|item| item.trim().to_ascii_lowercase())
            .filter(|item| !item.is_empty())
            .collect::<HashSet<_>>()
        })
        .unwrap_or_else(|| {
          fallback
            .iter()
            .map(|item| item.trim().to_ascii_lowercase())
            .filter(|item| !item.is_empty())
            .collect()
        })
    };
    let direction_keys = normalized_list("git_sync.allowed_directions", &self.runtime.git_sync.allowed_directions);
    let auth_keys = normalized_list(
      "git_sync.allowed_auth_methods",
      &self.runtime.git_sync.allowed_auth_methods,
    );
    let lifecycle_policy = GitSyncLifecyclePolicy {
      enabled: value("git_sync.enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(self.runtime.git_sync.enabled),
      allowed_directions: [
        ("bidirectional", SyncDirection::Bidirectional),
        ("myoxus_to_git", SyncDirection::MyoxusToGit),
        ("git_to_myoxus", SyncDirection::GitToMyoxus),
      ]
      .into_iter()
      .filter_map(|(key, direction)| direction_keys.contains(key).then_some(direction))
      .collect(),
      allowed_auth_methods: [
        ("https_token", AuthMethod::HttpsToken),
        ("https_password", AuthMethod::HttpsPassword),
        ("ssh_key", AuthMethod::SshKey),
      ]
      .into_iter()
      .filter_map(|(key, method)| auth_keys.contains(key).then_some(method))
      .collect(),
      allowed_hosts: normalized_list("git_sync.allowed_hosts", &self.runtime.git_sync.allowed_hosts),
      auto_sync_allowed: value("git_sync.auto_sync_allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(self.runtime.git_sync.auto_sync_allowed),
      webhook_allowed: value("git_sync.webhook_allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(self.runtime.git_sync.webhook_allowed),
    };
    let default_branch = value("git_sync.default_branch")
      .and_then(serde_json::Value::as_str)
      .map(str::trim)
      .filter(|branch| !branch.is_empty())
      .unwrap_or(&self.runtime.git_sync.default_branch)
      .to_string();
    let ssh_host_key_policy = value("git_sync.ssh_host_key_policy")
      .and_then(serde_json::Value::as_str)
      .and_then(SshHostKeyPolicy::parse)
      .unwrap_or(self.runtime.git_sync.ssh_host_key_policy);
    let https_certificate_policy = value("git_sync.https_certificate_policy")
      .and_then(serde_json::Value::as_str)
      .and_then(HttpsCertificatePolicy::parse)
      .unwrap_or(self.runtime.git_sync.https_certificate_policy);
    let https_ca_bundle = self.git_ca.clone();

    Ok(CliGitSyncRuntime {
      lifecycle_policy,
      default_branch,
      ssh_host_key_policy,
      https_certificate_policy,
      network_timeout_secs: self.runtime.git_sync.network_timeout_secs,
      local_timeout_secs: self.runtime.git_sync.local_timeout_secs,
      clone_depth: self.runtime.git_sync.clone_depth,
      crypto_private_key: self.runtime.crypto.private_key.clone(),
      https_ca_bundle,
    })
  }

  /// Resolve the effective workspace-import policy shared by CLI import and
  /// persisted-document Database migration commands.
  pub async fn workspace_import_policy(
    &self,
  ) -> anyhow::Result<myoxus_application::workspace_import::WorkspaceImportPolicy> {
    let import_config = self
      .runtime
      .workspace
      .r#import
      .with_runtime_overrides(&self.config_overrides);
    Ok(myoxus_application::workspace_import::WorkspaceImportPolicy {
      limits: import_config.decoder_limits(
        self.runtime.storage.max_upload_bytes(),
        self.runtime.websocket.max_http_buffer_size(),
        self.database_limits.max_fields_per_database,
        self.database_limits.max_views_per_database,
      ),
      staging_retention_hours: import_config.staging_retention_hours,
      job_timeout_seconds: import_config.job_timeout_seconds,
    })
  }

  pub async fn workspace_import(&self) -> anyhow::Result<Arc<WorkspaceImportService>> {
    // The CLI changes only the upload transport. Product policy, repositories
    // and worker execution remain identical to the API-owned import path.
    let policy: Arc<dyn WorkspaceImportPolicyProvider> = Arc::new(CliWorkspaceImportPolicyProvider {
      policy: self.workspace_import_policy().await?,
    });

    let storage = self.blob_storage()?;
    let blob_store = Arc::new(
      myoxus_infrastructure::blob::SqlxBlobStore::new(self.pool.clone())
        .with_quota_config(self.runtime.storage.default_workspace_quota_mb),
    );
    let blobs = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
      blob_store,
      storage.clone(),
      self.runtime.server.origin.clone(),
    ));

    let queue_url = self
      .runtime
      .redis
      .queue_url()
      .context("Redis queue role is required for workspace import")?;
    let queue_namespace = self.runtime.redis.queue_namespace();
    let client =
      myoxus_infrastructure::tls::redis::client(&queue_url, self.additional_ca.as_ref()).map_err(anyhow::Error::msg)?;
    let queue = myoxus_worker::RedisQueue::from_client(client, redis_queue_prefix(&queue_namespace));
    let queue: Arc<dyn WorkQueuePort> = Arc::new(CliRedisQueueAdapter { queue });
    let repository: Arc<dyn WorkspaceImportRepository> = Arc::new(PgWorkspaceImportRepository::new(self.pool.clone()));

    Ok(Arc::new(WorkspaceImportService::new(
      repository,
      storage,
      blobs,
      self.workspace_store.clone(),
      self.doc.clone(),
      self.databases.import_export.clone(),
      queue,
      policy,
    )))
  }

  /// Build the same server-owned vault projection used by the authenticated API.
  pub fn workspace_export(&self) -> anyhow::Result<Arc<ObsidianVaultExportService>> {
    let storage = self.blob_storage()?;
    let blob_store = Arc::new(
      myoxus_infrastructure::blob::SqlxBlobStore::new(self.pool.clone())
        .with_quota_config(self.runtime.storage.default_workspace_quota_mb),
    );
    let blobs = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
      blob_store,
      storage,
      self.runtime.server.origin.clone(),
    ));
    Ok(Arc::new(ObsidianVaultExportService::new(
      Arc::new(PermissionService::new(Arc::new(SqlxAuthStore::from_pool(
        self.pool.clone(),
      )))),
      self.workspace_store.clone(),
      self.doc.clone(),
      self.document_metadata.clone(),
      self.workspace_tag_repository.clone(),
      blobs,
      Arc::new(PgWorkspaceImportRepository::new(self.pool.clone())),
    )))
  }
}

fn configured_blob_storage_from(
  storage: &CliStorageConfig,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<Arc<dyn myoxus_application::ports::BlobStoragePort>> {
  let adapter = match storage.backend.as_str() {
    "local" => Arc::new(StorageAdapter::new_fs(storage.root.as_deref().unwrap_or("./storage"))?),
    "s3" | "r2" => Arc::new(StorageAdapter::new_s3(
      S3StorageConfig {
        bucket: storage
          .bucket
          .as_deref()
          .context("storage.bucket is required for s3/r2")?,
        prefix: storage.prefix.as_deref(),
        endpoint: storage.endpoint.as_deref(),
        region: storage.region.as_deref(),
        access_key: storage.access_key.as_deref(),
        secret_key: storage.secret_key.as_deref(),
        io_timeout_seconds: Some(storage.io_timeout_seconds),
        max_retries: Some(storage.s3_max_retries),
      },
      additional_ca,
    )?),
    backend => anyhow::bail!("unsupported storage backend `{backend}`"),
  };
  Ok(adapter)
}

pub async fn queue_adapter(
  redis_prefix: String,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> anyhow::Result<Option<Arc<dyn WorkQueuePort>>> {
  let redis_url = std::env::var("REDIS_URL")
    .ok()
    .or_else(|| std::env::var("MYOXUS__REDIS__URL").ok());
  let Some(redis_url) = redis_url else {
    return Ok(None);
  };
  let client = myoxus_infrastructure::tls::redis::client(&redis_url, additional_ca).map_err(anyhow::Error::msg)?;
  let queue = myoxus_worker::RedisQueue::from_client(client, redis_prefix);
  Ok(Some(Arc::new(CliRedisQueueAdapter { queue })))
}

pub fn default_redis_prefix() -> &'static str {
  DEFAULT_REDIS_PREFIX
}

/// Match the queue namespace used by the CLI's workspace-import producer.
pub(crate) fn redis_queue_prefix(queue_namespace: &str) -> String {
  format!("bull:{}", queue_namespace.trim_end_matches(":queue"))
}

struct CliRedisQueueAdapter {
  queue: myoxus_worker::RedisQueue,
}

#[async_trait::async_trait]
impl WorkQueuePort for CliRedisQueueAdapter {
  async fn add_job(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    max_attempts: Option<u32>,
    delay_ms: Option<i64>,
  ) -> myoxus_application::auth::AuthResult<String> {
    let opts = myoxus_worker::job::JobOptions {
      delay_ms,
      max_attempts: max_attempts.unwrap_or(3) as i32,
      ..Default::default()
    };
    self
      .queue
      .enqueue(queue, job_name, data, opts)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))
  }
}

/// CLI retry uses the same authoritative snapshot as the configured server,
/// including disabled admission; attaching Redis must not restore defaults.
fn load_workspace_automation_limits(
  overrides: &HashMap<String, serde_json::Value>,
  baseline: &myoxus_api::config::WorkspaceAutomationConfig,
) -> anyhow::Result<WorkspaceAutomationLimits> {
  let mut value = serde_json::to_value(baseline)?;
  for (path, configured) in overrides {
    if let Some(key) = path.strip_prefix("workspace_automation.") {
      value[key] = configured.clone();
    }
  }
  let config: myoxus_api::config::WorkspaceAutomationConfig = serde_json::from_value(value)?;
  anyhow::ensure!(
    config.max_actions_per_run > 0
      && config.max_runs_per_minute > 0
      && config.webhook_timeout_seconds > 0
      && config.max_retry_attempts > 0,
    "workspace_automation limits must be positive"
  );
  Ok(WorkspaceAutomationLimits {
    enabled: config.enabled,
    max_actions_per_run: config.max_actions_per_run,
    max_runs_per_minute: config.max_runs_per_minute,
    webhook_timeout_seconds: config.webhook_timeout_seconds,
    max_retry_attempts: config.max_retry_attempts,
  })
}

fn load_database_limits(overrides: &HashMap<String, serde_json::Value>, mut limits: DatabaseLimits) -> DatabaseLimits {
  apply_usize_config(
    overrides,
    "databases.max_fields_per_database",
    &mut limits.max_fields_per_database,
  );
  apply_usize_config(
    overrides,
    "databases.max_views_per_database",
    &mut limits.max_views_per_database,
  );
  apply_i64_config(overrides, "databases.max_rows_per_page", &mut limits.max_rows_per_page);
  apply_usize_config(
    overrides,
    "databases.max_cell_text_bytes",
    &mut limits.max_cell_text_bytes,
  );
  apply_usize_config(overrides, "databases.csv_max_bytes", &mut limits.csv_max_bytes);
  apply_usize_config(overrides, "databases.csv_max_rows", &mut limits.csv_max_rows);
  apply_usize_config(overrides, "databases.csv_max_columns", &mut limits.csv_max_columns);
  apply_usize_config(
    overrides,
    "databases.csv_sample_rows_for_type_inference",
    &mut limits.csv_sample_rows_for_type_inference,
  );
  apply_usize_config(
    overrides,
    "databases.max_reminders_per_user_per_cell",
    &mut limits.max_reminders_per_user_per_cell,
  );
  apply_i64_config(
    overrides,
    "databases.max_reminder_offset_minutes",
    &mut limits.max_reminder_offset_minutes,
  );
  limits
}

fn resolve_password_reset_ttl_seconds(
  overrides: &HashMap<String, serde_json::Value>,
  configured_default: i64,
) -> anyhow::Result<i64> {
  let ttl_seconds = match overrides.get("auth.password_reset_ttl_seconds") {
    Some(value) => value
      .as_i64()
      .context("auth.password_reset_ttl_seconds must be an integer")?,
    None => configured_default,
  };
  myoxus_application::auth::validate_password_reset_ttl_seconds(ttl_seconds)
    .map_err(|error| anyhow::anyhow!(error.to_string()))
}

fn resolve_password_policy(
  overrides: &HashMap<String, serde_json::Value>,
  fallback: &CliPasswordRequirementsConfig,
) -> anyhow::Result<PasswordPolicy> {
  let value = overrides.get("auth.password_requirements");
  let min = value
    .and_then(|value| value.get("min"))
    .and_then(serde_json::Value::as_u64)
    .and_then(|value| usize::try_from(value).ok())
    .unwrap_or(fallback.min);
  let max = value
    .and_then(|value| value.get("max"))
    .and_then(serde_json::Value::as_u64)
    .and_then(|value| usize::try_from(value).ok())
    .unwrap_or(fallback.max);
  PasswordPolicy::new(min, max).map_err(|error| anyhow::anyhow!(error.to_string()))
}

fn apply_usize_config(overrides: &HashMap<String, serde_json::Value>, key: &str, target: &mut usize) {
  if let Some(value) = overrides
    .get(key)
    .and_then(serde_json::Value::as_i64)
    .and_then(|value| usize::try_from(value).ok())
  {
    *target = value;
  }
}

fn apply_i64_config(overrides: &HashMap<String, serde_json::Value>, key: &str, target: &mut i64) {
  if let Some(value) = overrides.get(key).and_then(serde_json::Value::as_i64) {
    *target = value;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn database_config_projection_uses_server_defaults_for_omitted_fields() {
    let projected: CliDatabasesConfig = serde_json::from_value(serde_json::json!({
      "max_fields_per_database": 12,
      "max_views_per_database": 7,
      "max_rows_per_page": 80,
      "max_cell_text_bytes": 4096,
      "csv_max_bytes": 1048576,
      "csv_max_rows": 500,
      "csv_max_columns": 25,
      "csv_sample_rows_for_type_inference": 20
    }))
    .expect("partial Database config must remain a valid CLI projection");
    let defaults = DatabaseLimits::default();

    assert_eq!(projected.max_fields_per_database, 12);
    assert_eq!(
      projected.max_reminders_per_user_per_cell,
      defaults.max_reminders_per_user_per_cell
    );
    assert_eq!(
      projected.max_reminder_offset_minutes,
      defaults.max_reminder_offset_minutes
    );
  }

  #[test]
  fn database_config_projection_preserves_explicit_operator_values() {
    let projected: CliDatabasesConfig = serde_json::from_value(serde_json::json!({
      "max_reminders_per_user_per_cell": 8,
      "max_reminder_offset_minutes": 10080
    }))
    .expect("explicit Database config values must remain valid");

    assert_eq!(projected.max_reminders_per_user_per_cell, 8);
    assert_eq!(projected.max_reminder_offset_minutes, 10_080);
  }
}
