//! Application configuration loading and validation.
//!
//! [`AppConfig`] is the root configuration type. It is loaded by layering
//! YAML files (`default.yaml`, `${RUN_MODE}.yaml`, `local.yaml`) from the
//! `server/config/` directory and then applying `MYOXUS__*` environment
//! variable overrides. Sub-configs cover the database pool, Redis roles,
//! object storage, mail, OAuth providers, runtime auth policy defaults, and
//! feature flags.

use config::{Config, ConfigError};
use myoxus_application::git_sync::{HttpsCertificatePolicy, SshHostKeyPolicy};
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document, decode_typed_yaml_document};
use myoxus_contracts::effective_config::{CONFIG_REGISTRY, ConfigSourceSnapshot, validate_config_candidate};
pub use myoxus_contracts::oauth_config::{
  OAuthClaimsConfig, OAuthCustomProviderConfig, OAuthGroupMappingConfig, OAuthGroupMappingRuleConfig,
  OAuthMissingGroupsPolicy, OAuthProviderConfig, OAuthSimpleProviderConfig, OAuthUnknownGroupsPolicy,
};
use myoxus_contracts::runtime_config::{
  ServerConfigSources, load_server_config_sources, load_server_config_sources_for_candidate,
  resolve_server_config_paths,
};
use myoxus_pdf_export::ir::{DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE};
pub use myoxus_workspace_import::WorkspaceImportConfig;
use serde::{Deserialize, Serialize};
use std::{
  collections::{BTreeMap, HashMap, HashSet},
  fs,
  net::SocketAddr,
  path::{Path, PathBuf},
  sync::{Mutex, OnceLock},
};

/// Buffer for warning messages emitted before the tracing subscriber is
/// initialized (e.g. during [`AppConfig::load`]).  Call
/// [`drain_startup_warnings`] once after `init_tracing` to re-emit them via
/// `tracing::warn!`.
static STARTUP_WARNINGS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn push_startup_warning(msg: impl Into<String>) {
  let lock = STARTUP_WARNINGS.get_or_init(|| Mutex::new(Vec::new()));
  if let Ok(mut v) = lock.lock() {
    v.push(msg.into());
  }
}

/// Drain all buffered pre-init warnings and emit them via `tracing::warn!`.
/// Call this exactly once, immediately after the tracing subscriber has been
/// registered.
pub fn drain_startup_warnings() {
  if let Some(lock) = STARTUP_WARNINGS.get()
    && let Ok(mut v) = lock.lock()
  {
    for msg in v.drain(..) {
      tracing::warn!("{}", msg);
    }
  }
}

fn default_db_max_connections() -> u32 {
  50
}
fn default_db_min_connections() -> u32 {
  2
}
fn default_db_acquire_timeout_seconds() -> u64 {
  5
}

fn default_auth_reject_plus_aliases() -> bool {
  true
}

fn default_password_reset_ttl_seconds() -> i64 {
  myoxus_application::auth::DEFAULT_PASSWORD_RESET_TTL_SECONDS
}

/// Runtime authentication policy defaults.
///
/// These values are the server-owned baseline for new deployments. Admin
/// settings live in the `app_configs` table and override these YAML defaults at
/// runtime; see `graphql::config::typed_app_config_json` for the projection that
/// merges YAML defaults with DB overrides. Keep this type small and explicit:
/// only add fields here when the setting has a meaningful server default that
/// must be available even before an admin has written an `app_configs` row.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct AuthConfig {
  #[serde(default = "default_true")]
  pub allow_signup: bool,
  #[serde(default = "default_true")]
  pub allow_signup_for_oauth: bool,
  #[serde(default)]
  pub allowed_email_domains: Vec<String>,
  #[serde(default = "default_auth_dns_timeout_seconds")]
  pub dns_timeout_seconds: u64,
  #[serde(default)]
  pub require_email_domain_verification: bool,
  #[serde(default)]
  pub require_email_verification: bool,
  /// Reject signup/login email local-parts containing `+`.
  ///
  /// This is intentionally enabled by default for self-hosted deployments where
  /// invite/account policy usually expects canonical mailbox identities. Admins
  /// can still disable it through `auth.reject_plus_aliases` in the runtime
  /// config UI/API, which writes an `app_configs` override.
  #[serde(default = "default_auth_reject_plus_aliases")]
  pub reject_plus_aliases: bool,
  /// Password length contract enforced by every password-setting ingress.
  #[serde(default)]
  pub password_requirements: PasswordRequirementsConfig,
  /// Lifetime of newly created password-reset tokens. This setting is bound
  /// once at process startup; Admin DB overrides therefore require restart.
  #[serde(default = "default_password_reset_ttl_seconds")]
  pub password_reset_ttl_seconds: i64,
}

const fn default_auth_dns_timeout_seconds() -> u64 {
  5
}

impl Default for AuthConfig {
  fn default() -> Self {
    Self {
      allow_signup: true,
      allow_signup_for_oauth: true,
      allowed_email_domains: Vec::new(),
      dns_timeout_seconds: default_auth_dns_timeout_seconds(),
      require_email_domain_verification: false,
      require_email_verification: false,
      reject_plus_aliases: default_auth_reject_plus_aliases(),
      password_requirements: PasswordRequirementsConfig::default(),
      password_reset_ttl_seconds: default_password_reset_ttl_seconds(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordRequirementsConfig {
  #[serde(default = "default_password_min_length")]
  pub min: usize,
  #[serde(default = "default_password_max_length")]
  pub max: usize,
}

impl Default for PasswordRequirementsConfig {
  fn default() -> Self {
    Self {
      min: default_password_min_length(),
      max: default_password_max_length(),
    }
  }
}

const fn default_password_min_length() -> usize {
  myoxus_application::auth::DEFAULT_PASSWORD_MIN_LENGTH
}

const fn default_password_max_length() -> usize {
  myoxus_application::auth::DEFAULT_PASSWORD_MAX_LENGTH
}

/// Resolve the restart-bound password-reset TTL from the universal
/// `app_configs` snapshot. Runtime requests never read this value directly;
/// only a process restart materializes a newly persisted override.
pub fn resolve_password_reset_ttl_seconds(
  config: &AppConfig,
  app_config_values: &HashMap<String, serde_json::Value>,
) -> Result<i64, ConfigError> {
  let value = match app_config_values.get("auth.password_reset_ttl_seconds") {
    None => config.auth.password_reset_ttl_seconds,
    Some(value) => value
      .as_i64()
      .ok_or_else(|| ConfigError::Message("auth.password_reset_ttl_seconds must be an integer".to_string()))?,
  };
  myoxus_application::auth::validate_password_reset_ttl_seconds(value).map_err(|_| {
    ConfigError::Message(format!(
      "auth.password_reset_ttl_seconds must be between {} and {}, got {value}",
      myoxus_application::auth::MIN_PASSWORD_RESET_TTL_SECONDS,
      myoxus_application::auth::MAX_PASSWORD_RESET_TTL_SECONDS
    ))
  })
}

/// PostgreSQL connection pool configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DatabaseConfig {
  /// Full PostgreSQL connection URL (`postgres://user:pass@host/db`).
  pub url: String,
  /// Maximum number of connections the pool will open. Increase under high concurrency,
  /// but keep below PostgreSQL's `max_connections` limit minus connections used by other services.
  #[serde(default = "default_db_max_connections")]
  pub max_connections: u32,
  /// Minimum number of idle connections the pool keeps alive. Prevents cold-start latency
  /// on the first requests after a quiet period.
  #[serde(default = "default_db_min_connections")]
  pub min_connections: u32,
  /// Seconds to wait for a pool connection before returning PoolTimedOut.
  /// Low values let WebSocket ACK handlers fail fast instead of hanging.
  #[serde(default = "default_db_acquire_timeout_seconds")]
  pub acquire_timeout_seconds: u64,
}

/// Redis connection and role configuration.
/// Redis is a hard dependency — the server will refuse to start if Redis is unreachable.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RedisConfig {
  /// Default Redis URL used for all roles unless overridden per-role.
  pub url: Option<String>,
  /// Key prefix for all Redis keys. Override per role via `roles.*`.
  #[serde(default = "default_redis_namespace")]
  pub namespace: String,
  /// Per-role URL and namespace overrides. Use when each Redis role (cache, session, queue, socket, lock)
  /// has a separate Redis instance or database.
  #[serde(default)]
  pub roles: RedisRolesConfig,
  /// Session snapshot cache settings. Caching session data reduces DB load on every authenticated request.
  #[serde(default)]
  pub session_cache: RedisSessionCacheConfig,
  /// TTL (seconds) for cached workspace quota values. Default: 300 (5 min).
  #[serde(default = "default_cache_ttl_quota_seconds")]
  pub cache_ttl_quota_seconds: u64,
  /// TTL (seconds) for cached workspace usage values. Default: 60 (1 min).
  #[serde(default = "default_cache_ttl_usage_seconds")]
  pub cache_ttl_usage_seconds: u64,
  /// TTL (seconds) for cached git sync status values. Default: 120 (2 min).
  #[serde(default = "default_cache_ttl_git_status_seconds")]
  pub cache_ttl_git_status_seconds: u64,

  // ── P102-CACHE-06: Doc Snapshot Cache ────────────────────────────────────
  /// Enable Redis-backed doc snapshot cache. Default: true.
  #[serde(default = "default_doc_snapshot_cache_enabled")]
  pub doc_snapshot_cache_enabled: bool,
  /// TTL (seconds) for cached doc snapshots. Default: 120 (2 min).
  #[serde(default = "default_cache_ttl_doc_snapshot_seconds")]
  pub cache_ttl_doc_snapshot_seconds: u64,
  /// Maximum size (MB) of a snapshot eligible for caching. Snapshots larger than this
  /// are served from DB to avoid filling Redis with huge payloads. Default: 10 MB.
  #[serde(default = "default_doc_snapshot_cache_max_size_mb")]
  pub doc_snapshot_cache_max_size_mb: u64,

  // ── P102-CACHE-06: Doc Metadata Cache ────────────────────────────────────
  /// Enable Redis-backed doc metadata cache. Default: true.
  #[serde(default = "default_doc_metadata_cache_enabled")]
  pub doc_metadata_cache_enabled: bool,
  /// TTL (seconds) for cached doc metadata. Default: 60 (1 min).
  #[serde(default = "default_cache_ttl_doc_metadata_seconds")]
  pub cache_ttl_doc_metadata_seconds: u64,
  /// Enable Redis-backed canonical document metadata projection cache. Default: true.
  #[serde(default = "default_doc_metadata_projection_cache_enabled")]
  pub doc_metadata_projection_cache_enabled: bool,
  /// TTL (seconds) for cached canonical document metadata projections. Default: 60 (1 min).
  #[serde(default = "default_cache_ttl_doc_metadata_projection_seconds")]
  pub cache_ttl_doc_metadata_projection_seconds: u64,
  /// Enable the versioned workspace document-index cache. Default: true.
  #[serde(default = "default_document_metadata_index_cache_enabled")]
  pub document_metadata_index_cache_enabled: bool,
  /// TTL for versioned document-index entries. Applied on restart. Default: 60 seconds.
  #[serde(default = "default_cache_ttl_document_metadata_index_seconds")]
  pub cache_ttl_document_metadata_index_seconds: u64,
  /// Maximum serialized document-index entry size. Applied on restart. Default: 2 MB.
  #[serde(default = "default_document_metadata_index_cache_max_size_mb")]
  pub document_metadata_index_cache_max_size_mb: u64,

  // ── P102-CACHE-06: Doc View Dedup ────────────────────────────────────────
  /// Enable Redis-backed doc view deduplication (replaces in-process DashSet). Default: true.
  #[serde(default = "default_doc_view_dedup_enabled")]
  pub doc_view_dedup_enabled: bool,

  // ── P102-CACHE-06: Compaction Lock ───────────────────────────────────────
  /// Enable Redis-backed distributed compaction lock. Default: true.
  #[serde(default = "default_compaction_lock_enabled")]
  pub compaction_lock_enabled: bool,
  /// TTL (seconds) for the compaction lock. Default: 60 (1 min).
  #[serde(default = "default_compaction_lock_ttl_seconds")]
  pub compaction_lock_ttl_seconds: u64,

  // ── P102-CACHE-06: Timestamps Cache ──────────────────────────────────────
  /// Enable Redis-backed doc timestamps cache. Default: true.
  #[serde(default = "default_doc_timestamps_cache_enabled")]
  pub doc_timestamps_cache_enabled: bool,
  /// TTL (seconds) for cached doc timestamps. Default: 30 s.
  #[serde(default = "default_cache_ttl_doc_timestamps_seconds")]
  pub cache_ttl_doc_timestamps_seconds: u64,
  /// Maximum number of workspace timestamp maps to keep in cache. Default: 1000.
  #[serde(default = "default_doc_timestamps_cache_max_docs")]
  pub doc_timestamps_cache_max_docs: u64,

  // ── P103-A-03: Compaction thresholds ──────────────────────────────────────
  /// Number of pending updates before auto-compaction for regular docs. Default: 500.
  #[serde(default = "default_compaction_threshold_default")]
  pub compaction_threshold_default: u64,
  /// Number of pending updates before auto-compaction for the root/workspace doc. Default: 50.
  /// Root docs receive more frequent compaction because they are read on every workspace open.
  #[serde(default = "default_compaction_threshold_root_doc")]
  pub compaction_threshold_root_doc: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RedisRole {
  Cache,
  Session,
  Queue,
  Socket,
  Lock,
}

impl RedisRole {
  pub const ALL: [Self; 5] = [Self::Cache, Self::Session, Self::Queue, Self::Socket, Self::Lock];

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Cache => "cache",
      Self::Session => "session",
      Self::Queue => "queue",
      Self::Socket => "socket",
      Self::Lock => "lock",
    }
  }
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct RedisRoleConfig {
  pub url: Option<String>,
  pub namespace: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct RedisRolesConfig {
  #[serde(default)]
  pub cache: RedisRoleConfig,
  #[serde(default)]
  pub session: RedisRoleConfig,
  #[serde(default)]
  pub queue: RedisRoleConfig,
  #[serde(default)]
  pub socket: RedisRoleConfig,
  #[serde(default)]
  pub lock: RedisRoleConfig,
}

/// Controls whether session snapshots are cached in Redis.
/// When enabled, the session is fetched from Redis on each request instead of PostgreSQL,
/// reducing DB load significantly under high authenticated traffic.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RedisSessionCacheConfig {
  /// Enable session caching in Redis. Requires Redis to be enabled.
  #[serde(default = "default_redis_session_cache_enabled")]
  pub enabled: bool,
  /// Time-to-live for cached session entries in seconds.
  /// Lower values mean fresher data but more DB reads; values above `session_ttl` are pointless.
  #[serde(default = "default_redis_session_cache_ttl_seconds")]
  pub ttl_seconds: u64,
}

fn default_redis_namespace() -> String {
  "myoxus".to_string()
}

fn default_cache_ttl_quota_seconds() -> u64 {
  300
}

fn default_cache_ttl_usage_seconds() -> u64 {
  60
}

fn default_cache_ttl_git_status_seconds() -> u64 {
  120
}

fn default_redis_session_cache_enabled() -> bool {
  true
}

fn default_redis_session_cache_ttl_seconds() -> u64 {
  300
}

// ── P102-CACHE-06: Doc cache defaults ────────────────────────────────────────

fn default_doc_snapshot_cache_enabled() -> bool {
  true
}

fn default_cache_ttl_doc_snapshot_seconds() -> u64 {
  120
}

fn default_doc_snapshot_cache_max_size_mb() -> u64 {
  10
}

fn default_doc_metadata_cache_enabled() -> bool {
  true
}

fn default_cache_ttl_doc_metadata_seconds() -> u64 {
  60
}

fn default_doc_metadata_projection_cache_enabled() -> bool {
  true
}

fn default_cache_ttl_doc_metadata_projection_seconds() -> u64 {
  60
}

fn default_document_metadata_index_cache_enabled() -> bool {
  true
}

fn default_cache_ttl_document_metadata_index_seconds() -> u64 {
  60
}

fn default_document_metadata_index_cache_max_size_mb() -> u64 {
  2
}

fn default_doc_view_dedup_enabled() -> bool {
  true
}

fn default_compaction_lock_enabled() -> bool {
  true
}

fn default_compaction_lock_ttl_seconds() -> u64 {
  60
}

fn default_doc_timestamps_cache_enabled() -> bool {
  true
}

fn default_cache_ttl_doc_timestamps_seconds() -> u64 {
  30
}

fn default_doc_timestamps_cache_max_docs() -> u64 {
  1000
}

fn default_compaction_threshold_default() -> u64 {
  500
}

fn default_compaction_threshold_root_doc() -> u64 {
  50
}

impl Default for RedisSessionCacheConfig {
  fn default() -> Self {
    Self {
      enabled: default_redis_session_cache_enabled(),
      ttl_seconds: default_redis_session_cache_ttl_seconds(),
    }
  }
}

impl Default for RedisConfig {
  fn default() -> Self {
    Self {
      url: None,
      namespace: default_redis_namespace(),
      roles: RedisRolesConfig::default(),
      session_cache: RedisSessionCacheConfig::default(),
      cache_ttl_quota_seconds: default_cache_ttl_quota_seconds(),
      cache_ttl_usage_seconds: default_cache_ttl_usage_seconds(),
      cache_ttl_git_status_seconds: default_cache_ttl_git_status_seconds(),
      // P102-CACHE-06: Doc cache fields
      doc_snapshot_cache_enabled: default_doc_snapshot_cache_enabled(),
      cache_ttl_doc_snapshot_seconds: default_cache_ttl_doc_snapshot_seconds(),
      doc_snapshot_cache_max_size_mb: default_doc_snapshot_cache_max_size_mb(),
      doc_metadata_cache_enabled: default_doc_metadata_cache_enabled(),
      cache_ttl_doc_metadata_seconds: default_cache_ttl_doc_metadata_seconds(),
      doc_metadata_projection_cache_enabled: default_doc_metadata_projection_cache_enabled(),
      cache_ttl_doc_metadata_projection_seconds: default_cache_ttl_doc_metadata_projection_seconds(),
      document_metadata_index_cache_enabled: default_document_metadata_index_cache_enabled(),
      cache_ttl_document_metadata_index_seconds: default_cache_ttl_document_metadata_index_seconds(),
      document_metadata_index_cache_max_size_mb: default_document_metadata_index_cache_max_size_mb(),
      doc_view_dedup_enabled: default_doc_view_dedup_enabled(),
      compaction_lock_enabled: default_compaction_lock_enabled(),
      compaction_lock_ttl_seconds: default_compaction_lock_ttl_seconds(),
      doc_timestamps_cache_enabled: default_doc_timestamps_cache_enabled(),
      cache_ttl_doc_timestamps_seconds: default_cache_ttl_doc_timestamps_seconds(),
      doc_timestamps_cache_max_docs: default_doc_timestamps_cache_max_docs(),
      compaction_threshold_default: default_compaction_threshold_default(),
      compaction_threshold_root_doc: default_compaction_threshold_root_doc(),
    }
  }
}

impl RedisConfig {
  fn role_config(&self, role: RedisRole) -> &RedisRoleConfig {
    match role {
      RedisRole::Cache => &self.roles.cache,
      RedisRole::Session => &self.roles.session,
      RedisRole::Queue => &self.roles.queue,
      RedisRole::Socket => &self.roles.socket,
      RedisRole::Lock => &self.roles.lock,
    }
  }

  pub fn role_url(&self, role: RedisRole) -> Option<String> {
    self
      .role_config(role)
      .url
      .as_ref()
      .cloned()
      .or_else(|| self.url.clone())
  }

  pub fn role_namespace(&self, role: RedisRole) -> String {
    self
      .role_config(role)
      .namespace
      .as_ref()
      .cloned()
      .unwrap_or_else(|| format!("{}:{}", self.namespace, role.as_str()))
  }

  pub fn has_url(&self) -> bool {
    self.url.is_some() || RedisRole::ALL.iter().copied().any(|role| self.role_url(role).is_some())
  }
}

/// HTTP server and session lifetime configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
  /// Human-readable server name exposed to clients.
  #[serde(default = "default_server_name")]
  pub name: String,
  /// TCP port the server listens on. Typically 3001; fronted by Nginx at 3010.
  pub port: u16,
  /// IP address to bind to. Use `"0.0.0.0"` to accept connections from all interfaces,
  /// or `"127.0.0.1"` for local-only access.
  pub host: String,
  /// Public origin URL (e.g. `https://myoxus.example.com`). Used for redirect URIs,
  /// email links, and CORS validation.
  pub origin: String,
  /// Maximum session lifetime in seconds. After this many seconds a session is invalid
  /// regardless of activity.
  pub session_ttl: i64,
  /// Session refresh threshold in seconds. Sessions are proactively refreshed when
  /// they have less than `session_ttr` seconds of lifetime remaining.
  pub session_ttr: i64,
  /// TTL for magic-link / OTP verification tokens, in seconds (default: 1800 = 30 min).
  #[serde(default = "default_magic_link_ttl_seconds")]
  pub magic_link_ttl_seconds: i64,
  /// Graceful shutdown timeout in seconds. Worker handles are given this
  /// long to finish before the process exits. Default: 5.
  #[serde(default = "default_shutdown_timeout_seconds")]
  pub shutdown_timeout_seconds: u64,
  /// Deployment mode reported to clients via `serverConfig.deploymentType` and
  /// `serverConfig.type`.  Controls client-side socket transport
  /// (`"standalone"` → polling+WS upgrade, `"cloud"` → WS-only), telemetry
  /// method, admin UI modules, sign-in flow and desktop invite dialogs.
  ///
  /// Valid values: `"standalone"`, `"cloud"`. GraphQL projects these as the
  /// PascalCase values `"Standalone"` / `"Cloud"`.
  #[serde(default = "default_deployment_type")]
  pub deployment_type: String,
}

fn default_server_name() -> String {
  "Myoxus Server".to_string()
}

fn default_magic_link_ttl_seconds() -> i64 {
  1800 // 30 minutes
}

fn default_shutdown_timeout_seconds() -> u64 {
  5
}

fn default_deployment_type() -> String {
  "standalone".to_string()
}

fn default_crypto_private_key() -> String {
  "myoxus-change-me-private-key".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CryptoConfig {
  #[serde(default = "default_crypto_private_key")]
  pub private_key: String,
}

impl Default for CryptoConfig {
  fn default() -> Self {
    Self {
      private_key: default_crypto_private_key(),
    }
  }
}

fn default_throttle_enabled() -> bool {
  false
}

fn default_throttle_ttl_ms() -> u64 {
  60_000
}

fn default_throttle_limit_default() -> u32 {
  120
}

fn default_throttle_limit_strict() -> u32 {
  20
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ThrottlePolicyConfig {
  #[serde(default = "default_throttle_ttl_ms")]
  pub ttl_ms: u64,
  #[serde(default)]
  pub limit: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ThrottlePoliciesConfig {
  #[serde(default)]
  pub default: ThrottlePolicyConfig,
  #[serde(default = "default_throttle_strict_policy")]
  pub strict: ThrottlePolicyConfig,
}

fn default_throttle_strict_policy() -> ThrottlePolicyConfig {
  ThrottlePolicyConfig {
    ttl_ms: default_throttle_ttl_ms(),
    limit: default_throttle_limit_strict(),
  }
}

impl Default for ThrottlePolicyConfig {
  fn default() -> Self {
    Self {
      ttl_ms: default_throttle_ttl_ms(),
      limit: default_throttle_limit_default(),
    }
  }
}

impl Default for ThrottlePoliciesConfig {
  fn default() -> Self {
    Self {
      default: ThrottlePolicyConfig::default(),
      strict: default_throttle_strict_policy(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ThrottleConfig {
  #[serde(default = "default_throttle_enabled")]
  pub enabled: bool,
  #[serde(default)]
  pub throttlers: ThrottlePoliciesConfig,
}

impl Default for ThrottleConfig {
  fn default() -> Self {
    Self {
      enabled: default_throttle_enabled(),
      throttlers: ThrottlePoliciesConfig::default(),
    }
  }
}

fn default_doc_history_interval_ms() -> u64 {
  myoxus_application::document_version::DEFAULT_EDIT_CAPTURE_INTERVAL_MS as u64
}

fn default_doc_history_enabled() -> bool {
  true
}

fn deserialize_doc_history_interval_ms<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
  D: serde::Deserializer<'de>,
{
  let value = u64::deserialize(deserializer)?;
  if value == 0 || value > 86_400_000 {
    return Err(serde::de::Error::custom(
      "doc.history.interval must be positive and no greater than 86400000 milliseconds",
    ));
  }
  Ok(value.max(myoxus_application::document_version::MIN_EDIT_CAPTURE_INTERVAL_MS as u64))
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct DocExperimentalConfig {
  #[serde(default)]
  pub yocto: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocHistoryConfig {
  #[serde(default = "default_doc_history_enabled")]
  pub enabled: bool,
  #[serde(
    default = "default_doc_history_interval_ms",
    deserialize_with = "deserialize_doc_history_interval_ms"
  )]
  pub interval: u64,
}

impl Default for DocHistoryConfig {
  fn default() -> Self {
    Self {
      enabled: default_doc_history_enabled(),
      interval: default_doc_history_interval_ms(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocConfig {
  /// Shared pull/external-write decoder admission; applied only at startup.
  #[serde(
    default = "default_doc_decoder_concurrency",
    deserialize_with = "myoxus_contracts::effective_config::deserialize_doc_decoder_concurrency"
  )]
  pub decoder_concurrency: usize,
  #[serde(default)]
  pub experimental: DocExperimentalConfig,
  #[serde(default)]
  pub history: DocHistoryConfig,
  #[serde(default)]
  pub ingress: DocIngressConfig,
}

fn default_doc_decoder_concurrency() -> usize {
  myoxus_contracts::effective_config::DEFAULT_DOC_DECODER_CONCURRENCY
}

impl Default for DocConfig {
  fn default() -> Self {
    Self {
      decoder_concurrency: default_doc_decoder_concurrency(),
      experimental: DocExperimentalConfig::default(),
      history: DocHistoryConfig::default(),
      ingress: DocIngressConfig::default(),
    }
  }
}

fn default_doc_ingress_max_update_mb() -> u64 {
  32
}

/// Startup-only limits for bytes received from external document clients.
///
/// The limit is applied after Base64 transport decoding and before any
/// persistence, cache invalidation, compaction or broadcast side effect.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DocIngressConfig {
  #[serde(default = "default_doc_ingress_max_update_mb")]
  pub max_update_mb: u64,
}

impl Default for DocIngressConfig {
  fn default() -> Self {
    Self {
      max_update_mb: default_doc_ingress_max_update_mb(),
    }
  }
}

impl DocIngressConfig {
  /// Convert the configured MiB value without allowing arithmetic or host
  /// pointer-width overflow. Startup validation rejects `None`.
  pub fn max_update_bytes(&self) -> Option<usize> {
    self
      .max_update_mb
      .checked_mul(1024 * 1024)
      .and_then(|bytes| usize::try_from(bytes).ok())
      .filter(|bytes| *bytes > 0)
  }
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct DocServiceConfig {
  pub endpoint: Option<String>,
}

fn default_client_version_control_enabled() -> bool {
  true
}

fn default_client_required_version() -> String {
  ">=0.41.5".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClientVersionControlConfig {
  #[serde(default = "default_client_version_control_enabled")]
  pub enabled: bool,
  #[serde(default = "default_client_required_version")]
  pub required_version: String,
}

impl Default for ClientVersionControlConfig {
  fn default() -> Self {
    Self {
      enabled: default_client_version_control_enabled(),
      required_version: default_client_required_version(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ClientConfig {
  #[serde(default)]
  pub download_url: String,
  #[serde(default)]
  pub clipboard_http_fallback: bool,
  #[serde(default)]
  pub version_control: ClientVersionControlConfig,
}

fn default_i18n_default_locale() -> String {
  "en".to_string()
}

fn default_i18n_available_locales() -> Vec<String> {
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
    "el-GR".to_string(),
  ]
}

fn default_i18n_default_currency() -> String {
  myoxus_domain::database::default_database_currency_code()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct I18nConfig {
  #[serde(default = "default_i18n_default_locale")]
  pub default_locale: String,
  #[serde(default = "default_i18n_available_locales")]
  pub available_locales: Vec<String>,
  #[serde(default = "default_i18n_default_currency")]
  pub default_currency: String,
}

impl Default for I18nConfig {
  fn default() -> Self {
    Self {
      default_locale: default_i18n_default_locale(),
      available_locales: default_i18n_available_locales(),
      default_currency: default_i18n_default_currency(),
    }
  }
}

fn default_admin_i18n_default_locale() -> String {
  "en".to_string()
}

/// Language configuration for the admin frontend.
///
/// Separate from the web-frontend `i18n` configuration so admins can
/// set the admin panel language independently of the end-user locale.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminI18nConfig {
  /// BCP-47 locale tag for the admin panel UI (e.g. `"en"`, `"de"`).
  /// Defaults to `"en"` when not configured.
  #[serde(default = "default_admin_i18n_default_locale")]
  pub default_locale: String,
}

impl Default for AdminI18nConfig {
  fn default() -> Self {
    Self {
      default_locale: default_admin_i18n_default_locale(),
    }
  }
}

/// Outgoing email (SMTP) configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MailConfig {
  /// RFC 5321 sender address used in the `From:` header (e.g. `noreply@myoxus.example.com`).
  pub sender: String,
  /// SMTP server hostname. When `None`, email sending is disabled and operations
  /// that would send mail are silently skipped.
  pub smtp_host: Option<String>,
  /// SMTP server port. Common values: 25 (plain), 465 (TLS), 587 (STARTTLS).
  pub smtp_port: u16,
  /// Optional hostname announced to the SMTP relay via EHLO/HELO.
  #[serde(default)]
  pub smtp_name: Option<String>,
  /// SMTP authentication username. Leave `None` for unauthenticated relays.
  pub smtp_user: Option<String>,
  /// SMTP authentication password. Keep this secret and never log it.
  pub smtp_pass: Option<String>,
  /// Explicit SMTP wire transport. The configured port never changes this mode.
  #[serde(default)]
  pub smtp_transport: myoxus_infrastructure::mail::SmtpTransportMode,
  /// Require a certificate that chains to a trusted root for TLS transports.
  #[serde(default = "default_true")]
  pub smtp_verify_certificate: bool,
  /// Recipient domains routed through the fallback endpoint.
  #[serde(default)]
  pub fallback_domains: Vec<String>,
  /// Optional secondary SMTP endpoint for the configured fallback domains.
  #[serde(default)]
  pub fallback_smtp: Option<FallbackSmtpConfig>,
  /// When `true`, system notification emails (e.g. workspace invitations) are sent.
  /// Safe to disable in development to avoid accidental outbound mail.
  #[serde(default)]
  pub enable_notification_emails: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FallbackSmtpConfig {
  pub host: String,
  pub port: u16,
  #[serde(default)]
  pub name: Option<String>,
  #[serde(default)]
  pub username: Option<String>,
  #[serde(default)]
  pub password: Option<String>,
  #[serde(default)]
  pub transport: myoxus_infrastructure::mail::SmtpTransportMode,
  #[serde(default = "default_true")]
  pub verify_certificate: bool,
  pub sender: String,
}

impl MailConfig {
  /// Build the SMTP adapter input with the startup-resolved mail directory.
  pub fn into_adapter_config(self, template_dir: String) -> myoxus_infrastructure::mail::MailConfig {
    let c = self;
    let fallback_smtp = c
      .fallback_smtp
      .map(|fallback| myoxus_infrastructure::mail::FallbackMailConfig {
        smtp: myoxus_infrastructure::mail::SmtpTransportConfig {
          host: fallback.host,
          port: fallback.port,
          name: fallback.name,
          username: fallback.username,
          password: fallback.password,
          transport: fallback.transport,
          verify_certificate: fallback.verify_certificate,
        },
        from_email: fallback.sender,
      });
    myoxus_infrastructure::mail::MailConfig {
      smtp_host: c.smtp_host.unwrap_or_default(),
      smtp_port: c.smtp_port,
      smtp_name: c.smtp_name,
      smtp_user: c.smtp_user,
      smtp_pass: c.smtp_pass,
      smtp_transport: c.smtp_transport,
      smtp_verify_certificate: c.smtp_verify_certificate,
      fallback_smtp,
      fallback_domains: c.fallback_domains,
      from_email: c.sender,
      template_dir,
    }
  }
}

/// Operator-owned template root captured at startup; edits require a restart.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct TemplatesConfig {
  /// Relative paths resolve from the API process working directory.
  pub root_dir: String,
}

impl Default for TemplatesConfig {
  fn default() -> Self {
    Self {
      root_dir: "./templates".into(),
    }
  }
}

/// Blob storage backend. Determines which opendal operator is used at startup.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
  /// Local filesystem storage. Use for development or single-node deployments where
  /// data loss on disk failure is acceptable.
  Local,
  /// Amazon S3 (or any S3-compatible service, e.g. MinIO).
  S3,
  /// Cloudflare R2 (S3-compatible, no egress fees).
  R2,
}

fn default_storage_backend() -> StorageBackend {
  StorageBackend::Local
}

fn default_signed_url_ttl_seconds() -> u64 {
  3600
}

fn default_max_upload_mb() -> u64 {
  512 // 512 MiB
}

fn default_multipart_threshold_mb() -> u64 {
  8 // 8 MiB
}

fn default_multipart_part_size_bytes() -> u64 {
  5 * 1024 * 1024
}

fn default_multipart_max_parts() -> u32 {
  10_000
}

fn default_min_free_space_mb() -> u64 {
  0
}
fn default_storage_io_timeout_seconds() -> u64 {
  15
}
fn default_s3_max_retries() -> usize {
  3
}

fn default_logging_level() -> String {
  // Sane per-module defaults: Myoxus crates at info, noisy dependencies at warn.
  // The full string is an EnvFilter directive — comma-separated module=level pairs.
  // Users can override via config or MYOXUS__LOGGING__LEVEL / RUST_LOG env vars.
  [
    "info",
    "sqlx::query=warn",
    "tungstenite=warn",
    "tokio_tungstenite=warn",
    "axum::serve=warn",
    "hyper=warn",
    "tower_http=warn",
    "h2=warn",
    "rustls=warn",
  ]
  .join(",")
}

fn default_logging_max_files() -> usize {
  7
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogRotation {
  Never,
  Daily,
  Hourly,
}

fn default_log_rotation() -> LogRotation {
  LogRotation::Daily
}

/// Blob (file/avatar/attachment) storage configuration.
/// Fields that are `None` are only required by specific backends (S3/R2 need `bucket`,
/// `access_key`, `secret_key`; `Local` needs `root`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StorageConfig {
  /// Which storage backend to use. Defaults to `local`.
  #[serde(default = "default_storage_backend")]
  pub backend: StorageBackend,
  /// S3/R2 bucket name. Required for `s3` and `r2` backends.
  pub bucket: Option<String>,
  /// Custom S3-compatible endpoint URL. Leave `None` to use the AWS default.
  pub endpoint: Option<String>,
  /// AWS/R2 region (e.g. `us-east-1`). Required for `s3`.
  pub region: Option<String>,
  /// S3/R2 access key ID. Required for `s3` and `r2` backends.
  pub access_key: Option<String>,
  /// S3/R2 secret access key. Keep secret — never log or expose.
  pub secret_key: Option<String>,
  /// Filesystem root directory for the `local` backend.
  pub root: Option<String>,
  /// Optional path prefix applied to every object key, useful for multi-tenant buckets.
  pub prefix: Option<String>,
  /// Lifetime of signed (pre-signed) download URLs in seconds. Default 3600 (1 hour).
  #[serde(default = "default_signed_url_ttl_seconds")]
  pub signed_url_ttl_seconds: u64,
  /// Maximum permitted upload size in MB. Requests exceeding this are rejected at
  /// the HTTP layer before touching storage. Default 512 MiB.
  ///
  /// **Backwards compatibility**: Also accepts deprecated YAML key `maxUploadBytes`.
  /// If the deserialized value exceeds 1024, `apply_storage_mb_bytes_migration()`
  /// assumes it was specified in bytes and auto-converts to MB.
  #[serde(default = "default_max_upload_mb", alias = "maxUploadBytes")]
  pub max_upload_mb: u64,
  /// File size above which multipart upload is used instead of a single PUT. Default 8 MiB.
  ///
  /// **Backwards compatibility**: Also accepts deprecated YAML key `multipartThresholdBytes`.
  /// Values > 1024 are auto-converted from bytes to MB by the migration method.
  #[serde(default = "default_multipart_threshold_mb", alias = "multipartThresholdBytes")]
  pub multipart_threshold_mb: u64,
  /// Size of each multipart part in bytes. Must be ≥ 5 MiB for S3. Default 5 MiB.
  #[serde(default = "default_multipart_part_size_bytes")]
  pub multipart_part_size_bytes: u64,
  /// Maximum number of multipart parts. S3 allows up to 10 000. Default 10 000.
  #[serde(default = "default_multipart_max_parts")]
  pub multipart_max_parts: u32,
  /// Minimum free disk space in MB required before an upload is accepted on the
  /// `local` backend. `0` disables the check.
  ///
  /// **Backwards compatibility**: Also accepts deprecated YAML key `minFreeSpaceBytes`.
  /// Values > 1024 are auto-converted from bytes to MB by the migration method.
  #[serde(default = "default_min_free_space_mb", alias = "minFreeSpaceBytes")]
  pub min_free_space_mb: u64,
  /// Per-attempt I/O timeout for S3 operations in seconds.  Each read, write,
  /// or delete attempt is individually bounded by this duration.
  #[serde(default = "default_storage_io_timeout_seconds")]
  pub io_timeout_seconds: u64,
  /// Maximum number of retry attempts for each S3 operation before giving up. Default: 3.
  #[serde(default = "default_s3_max_retries")]
  pub s3_max_retries: usize,
  /// Default workspace storage quota in MB. 0 = unlimited (P37-A-03).
  /// Applied when the workspace has no explicit override.
  #[serde(default)]
  pub default_workspace_quota_mb: u64,
}

impl StorageConfig {
  /// Convert max_upload_mb to bytes (overflow-safe).
  pub fn max_upload_bytes(&self) -> u64 {
    self.max_upload_mb.saturating_mul(1_048_576)
  }

  /// Convert multipart_threshold_mb to bytes (overflow-safe).
  pub fn multipart_threshold_bytes(&self) -> u64 {
    self.multipart_threshold_mb.saturating_mul(1_048_576)
  }

  /// Convert min_free_space_mb to bytes (overflow-safe).
  pub fn min_free_space_bytes(&self) -> u64 {
    self.min_free_space_mb.saturating_mul(1_048_576)
  }
}

fn default_public_static_export_root() -> String {
  "/var/lib/myoxus/public".to_string()
}

fn default_public_static_retention_releases() -> usize {
  5
}

fn default_public_html_cache_ttl_seconds() -> u64 {
  300
}

fn default_public_asset_cache_max_age_seconds() -> u64 {
  31_536_000
}

fn default_public_site_shell_max_toc_depth() -> u8 {
  3
}

fn default_pagefind_binary() -> String {
  "pagefind".to_string()
}

/// Visual and navigation controls for public HTML pages.
///
/// These switches only control the anonymous publishing renderer. They do not
/// grant access; access remains governed by `docs.public_mode`,
/// `workspaces.public`, and the public ACL service.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PublicPublishingSiteShellConfig {
  /// Render a public breadcrumb trail above document content.
  #[serde(default = "default_true")]
  pub breadcrumbs_enabled: bool,
  /// Render a table of contents derived from public document headings.
  #[serde(default = "default_true")]
  pub toc_enabled: bool,
  /// Maximum heading depth included in the public table of contents.
  #[serde(default = "default_public_site_shell_max_toc_depth")]
  pub max_toc_depth: u8,
  /// Render previous/next document navigation when route context provides adjacent pages.
  #[serde(default = "default_true")]
  pub previous_next_enabled: bool,
  /// Add copy controls for public code blocks.
  #[serde(default = "default_true")]
  pub code_copy_enabled: bool,
  /// Apply server-side syntax highlighting to public code blocks.
  #[serde(default = "default_true")]
  pub syntax_highlighting_enabled: bool,
  /// Reserved for public search surfaces; dynamic public pages currently render without Pagefind.
  #[serde(default = "default_true")]
  pub search_enabled: bool,
}

impl Default for PublicPublishingSiteShellConfig {
  fn default() -> Self {
    Self {
      breadcrumbs_enabled: true,
      toc_enabled: true,
      max_toc_depth: default_public_site_shell_max_toc_depth(),
      previous_next_enabled: true,
      code_copy_enabled: true,
      syntax_highlighting_enabled: true,
      search_enabled: true,
    }
  }
}

/// Pagefind integration retained for the legacy CLI HTML snapshot utility.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PublicPublishingPagefindConfig {
  /// Run Pagefind after CLI snapshot generation.
  #[serde(default = "default_true")]
  pub enabled: bool,
  /// Executable name or absolute path used by the CLI snapshot command.
  #[serde(default = "default_pagefind_binary")]
  pub binary: String,
}

impl Default for PublicPublishingPagefindConfig {
  fn default() -> Self {
    Self {
      enabled: true,
      binary: default_pagefind_binary(),
    }
  }
}

/// Server-rendered Open Graph image generation for public documents.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PublicPublishingSocialCardsConfig {
  /// Generate and expose deterministic PNG social cards for public documents.
  #[serde(default = "default_true")]
  pub enabled: bool,
}

impl Default for PublicPublishingSocialCardsConfig {
  fn default() -> Self {
    Self { enabled: true }
  }
}

/// Operational configuration for anonymous public publishing.
///
/// The boolean flags and cache settings control delivery and renderer
/// behaviour only. They deliberately do not encode per-document permissions:
/// `docs.public_mode` and `workspaces.public` remain the authoritative
/// publishing metadata.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PublicPublishingConfig {
  /// Master switch for anonymous public API routes.
  #[serde(default = "default_true")]
  pub enabled: bool,
  /// Serve `/public/{workspace_id}` and `/public/{workspace_id}/{doc_id}` from the API.
  #[serde(default = "default_true")]
  pub dynamic_routes_enabled: bool,
  /// Root directory for the legacy CLI HTML snapshot utility.
  #[serde(default = "default_public_static_export_root")]
  pub static_export_root: String,
  /// Number of completed CLI HTML snapshots retained by cleanup jobs.
  #[serde(default = "default_public_static_retention_releases")]
  pub static_retention_releases: usize,
  /// Cache TTL for public HTML responses in dynamic mode.
  #[serde(default = "default_public_html_cache_ttl_seconds")]
  pub html_cache_ttl_seconds: u64,
  /// Long-lived cache max-age for content-hashed public assets.
  #[serde(default = "default_public_asset_cache_max_age_seconds")]
  pub asset_cache_max_age_seconds: u64,
  /// Default robots behaviour for public pages until document-specific SEO exists.
  #[serde(default)]
  pub default_noindex: bool,
  /// Public page shell and renderer feature controls.
  #[serde(default)]
  pub site_shell: PublicPublishingSiteShellConfig,
  /// Static Pagefind search generation.
  #[serde(default)]
  pub pagefind: PublicPublishingPagefindConfig,
  /// Social card generation and delivery.
  #[serde(default)]
  pub social_cards: PublicPublishingSocialCardsConfig,
}

/// Operator-owned resource and lifecycle policy for Page preview generation.
///
/// Request-scoped fields are re-resolved from the live configuration snapshot.
/// Semaphore and cache construction fields are intentionally restart-bound in
/// the canonical registry and are captured when API state is built.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct PreviewConfig {
  pub max_input_bytes: usize,
  pub max_source_blocks: usize,
  pub max_projected_blocks: usize,
  pub max_text_chars: usize,
  pub max_depth: usize,
  pub max_table_rows: usize,
  pub max_table_columns: usize,
  pub max_visuals: usize,
  pub max_media_bytes: usize,
  pub max_font_bytes: usize,
  pub max_decoded_image_pixels: u64,
  pub max_svg_input_bytes: usize,
  pub max_mermaid_source_bytes: usize,
  pub max_mermaid_elements: usize,
  pub max_outlined_paths: usize,
  pub max_output_svg_bytes: usize,
  pub max_png_pixels: u64,
  pub max_active_global_renders: usize,
  pub max_active_renders_per_actor: usize,
  pub max_in_flight_requests: usize,
  pub output_cache_max_bytes: u64,
  pub output_cache_max_entries: u64,
  pub output_cache_ttl_seconds: u64,
  pub prepared_font_cache_max_bytes: u64,
  pub prepared_font_cache_max_entries: u64,
  pub prepared_font_cache_ttl_seconds: u64,
  pub request_timeout_ms: u64,
  pub render_timeout_ms: u64,
  pub failure_expiry_seconds: u64,
  pub retry_count: u32,
}

impl Default for PreviewConfig {
  fn default() -> Self {
    Self {
      max_input_bytes: 16_777_216,
      max_source_blocks: 10_000,
      max_projected_blocks: 30,
      max_text_chars: 4_000,
      max_depth: 32,
      max_table_rows: 4,
      max_table_columns: 4,
      max_visuals: 1,
      max_media_bytes: 4_194_304,
      max_font_bytes: 33_554_432,
      max_decoded_image_pixels: 16_777_216,
      max_svg_input_bytes: 2_097_152,
      max_mermaid_source_bytes: 262_144,
      max_mermaid_elements: 1_000,
      max_outlined_paths: 100_000,
      max_output_svg_bytes: 4_194_304,
      max_png_pixels: 256_000,
      max_active_global_renders: 8,
      max_active_renders_per_actor: 2,
      max_in_flight_requests: 32,
      output_cache_max_bytes: 134_217_728,
      output_cache_max_entries: 1_000,
      output_cache_ttl_seconds: 300,
      prepared_font_cache_max_bytes: 67_108_864,
      prepared_font_cache_max_entries: 8,
      prepared_font_cache_ttl_seconds: 3_600,
      request_timeout_ms: 5_000,
      render_timeout_ms: 3_000,
      failure_expiry_seconds: 5,
      retry_count: 1,
    }
  }
}

impl Default for PublicPublishingConfig {
  fn default() -> Self {
    Self {
      enabled: true,
      dynamic_routes_enabled: true,
      static_export_root: default_public_static_export_root(),
      static_retention_releases: default_public_static_retention_releases(),
      html_cache_ttl_seconds: default_public_html_cache_ttl_seconds(),
      asset_cache_max_age_seconds: default_public_asset_cache_max_age_seconds(),
      default_noindex: false,
      site_shell: PublicPublishingSiteShellConfig::default(),
      pagefind: PublicPublishingPagefindConfig::default(),
      social_cards: PublicPublishingSocialCardsConfig::default(),
    }
  }
}

/// Structured log output configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoggingConfig {
  /// Minimum log level as a `tracing` filter string (e.g. `"info"`, `"debug"`,
  /// `"myoxus_api=debug,warn"`). Defaults to `"info"`.
  #[serde(default = "default_logging_level")]
  pub level: String,
  /// If set, logs are also written to this file path in addition to stdout.
  /// Supports log rotation via `rotation`.
  pub file_path: Option<String>,
  /// How often to rotate the log file. Ignored when `file_path` is `None`.
  #[serde(default = "default_log_rotation")]
  pub rotation: LogRotation,
  /// Maximum number of rotated log files to keep on disk. Older files are deleted.
  #[serde(default = "default_logging_max_files")]
  pub max_files: usize,
  /// Maximum number of runtime log-level change history entries to keep.
  #[serde(default = "default_logging_max_history")]
  pub max_history: usize,
}

fn default_logging_max_history() -> usize {
  20
}

impl Default for LoggingConfig {
  fn default() -> Self {
    Self {
      level: default_logging_level(),
      file_path: None,
      rotation: default_log_rotation(),
      max_files: default_logging_max_files(),
      max_history: default_logging_max_history(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaPlan {
  Free,
  Pro,
  LifetimePro,
  Unlimited,
}

impl QuotaPlan {
  pub fn display_name(&self) -> &'static str {
    match self {
      Self::Free => "Free",
      Self::Pro => "Pro",
      Self::LifetimePro => "Lifetime Pro",
      Self::Unlimited => "Unlimited",
    }
  }
}

fn default_quota_plan() -> QuotaPlan {
  QuotaPlan::Pro
}

fn default_quota_blob_limit() -> i32 {
  i32::MAX
}

fn default_quota_storage_quota() -> i64 {
  i64::MAX
}

fn default_quota_history_period() -> i32 {
  i32::MAX
}

fn default_quota_member_limit() -> i32 {
  i32::MAX
}

fn default_quota_copilot_limit() -> i64 {
  i64::MAX
}

fn default_quota_copilot_used() -> i64 {
  0
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityQuotaConfig {
  #[serde(default = "default_quota_blob_limit")]
  pub blob_limit: i32,
  #[serde(default = "default_quota_storage_quota")]
  pub storage_quota: i64,
  #[serde(default = "default_quota_history_period")]
  pub history_period: i32,
  #[serde(default = "default_quota_member_limit")]
  pub member_limit: i32,
  #[serde(default = "default_quota_copilot_limit")]
  pub copilot_limit: i64,
  #[serde(default = "default_quota_copilot_used")]
  pub copilot_used: i64,
}

impl Default for CompatibilityQuotaConfig {
  fn default() -> Self {
    Self {
      blob_limit: default_quota_blob_limit(),
      storage_quota: default_quota_storage_quota(),
      history_period: default_quota_history_period(),
      member_limit: default_quota_member_limit(),
      copilot_limit: default_quota_copilot_limit(),
      copilot_used: default_quota_copilot_used(),
    }
  }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub enum CompatibilityFeature {
  #[serde(rename = "AIEarlyAccess", alias = "ai_early_access")]
  AIEarlyAccess,
  #[serde(rename = "Admin", alias = "admin")]
  Admin,
  #[serde(rename = "EarlyAccess", alias = "early_access")]
  EarlyAccess,
  #[serde(rename = "FreePlan", alias = "free_plan")]
  FreePlan,
  #[serde(rename = "LifetimeProPlan", alias = "lifetime_pro_plan")]
  LifetimeProPlan,
  #[serde(rename = "ProPlan", alias = "pro_plan")]
  ProPlan,
  #[serde(rename = "TeamPlan", alias = "team_plan")]
  TeamPlan,
  #[serde(rename = "UnlimitedCopilot", alias = "unlimited_copilot")]
  UnlimitedCopilot,
  #[serde(rename = "UnlimitedWorkspace", alias = "unlimited_workspace")]
  UnlimitedWorkspace,
  /// Global Manager capability that makes a user eligible for OU management.
  /// It grants no permission by itself and becomes effective only together
  /// with an `organization_unit_member.role = 'manager'` membership. See the
  /// permission matrix in `docs/dev/server/organization-management.md` and
  /// learning `LRN-20260502-ORG-A-01`.
  #[serde(rename = "Manager", alias = "manager")]
  Manager,
}

fn default_compat_user_features_file() -> String {
  "features.user.yaml".to_string()
}

fn default_compat_workspace_features_file() -> String {
  "features.workspace.yaml".to_string()
}

fn default_compat_user_features() -> Vec<CompatibilityFeature> {
  Vec::new()
}

fn default_compat_workspace_features() -> Vec<CompatibilityFeature> {
  Vec::new()
}

fn dedup_compat_features(features: &mut Vec<CompatibilityFeature>) {
  let mut seen = HashSet::new();
  features.retain(|feature| seen.insert(*feature));
}

fn is_allowed_static_feature(feature: CompatibilityFeature) -> bool {
  !matches!(
    feature,
    CompatibilityFeature::Admin
      | CompatibilityFeature::FreePlan
      | CompatibilityFeature::LifetimeProPlan
      | CompatibilityFeature::ProPlan
      | CompatibilityFeature::TeamPlan
      | CompatibilityFeature::UnlimitedWorkspace
  )
}

fn strip_unsupported_static_features(features: &mut Vec<CompatibilityFeature>) {
  let removed = features
    .iter()
    .copied()
    .filter(|feature| !is_allowed_static_feature(*feature))
    .collect::<Vec<_>>();
  features.retain(|feature| is_allowed_static_feature(*feature));
  if !removed.is_empty() {
    push_startup_warning(format!(
      "ignored unsupported static compatibility features: {:?}",
      removed
    ));
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityFeaturesConfig {
  #[serde(default = "default_compat_user_features_file")]
  pub user_file: String,
  #[serde(default = "default_compat_workspace_features_file")]
  pub workspace_file: String,
  #[serde(default = "default_compat_user_features")]
  pub user: Vec<CompatibilityFeature>,
  #[serde(default = "default_compat_workspace_features")]
  pub workspace: Vec<CompatibilityFeature>,
}

impl Default for CompatibilityFeaturesConfig {
  fn default() -> Self {
    Self {
      user_file: default_compat_user_features_file(),
      workspace_file: default_compat_workspace_features_file(),
      user: default_compat_user_features(),
      workspace: default_compat_workspace_features(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BillingPlan {
  #[serde(rename = "ai")]
  AI,
  Enterprise,
  Free,
  Pro,
  SelfHosted,
  SelfHostedTeam,
  Team,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BillingRecurring {
  Lifetime,
  Monthly,
  Yearly,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BillingStatus {
  Active,
  Canceled,
  Incomplete,
  IncompleteExpired,
  PastDue,
  Paused,
  Trialing,
  Unpaid,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BillingVariant {
  #[serde(rename = "ea")]
  EA,
  Onetime,
}

fn default_billing_plan() -> BillingPlan {
  BillingPlan::SelfHostedTeam
}

fn default_billing_recurring() -> BillingRecurring {
  BillingRecurring::Lifetime
}

fn default_billing_currency() -> String {
  "USD".to_string()
}

fn default_billing_price_type() -> String {
  "default".to_string()
}

fn default_billing_subscription_id() -> String {
  "neutral".to_string()
}

fn default_billing_active_status() -> BillingStatus {
  BillingStatus::Active
}

fn default_billing_canceled_status() -> BillingStatus {
  BillingStatus::Canceled
}

fn default_billing_license_quantity() -> i32 {
  i32::MAX
}

fn default_billing_license_variant() -> Option<BillingVariant> {
  Some(BillingVariant::Onetime)
}

fn default_billing_checkout_path() -> String {
  "/billing/neutral-checkout".to_string()
}

fn default_billing_customer_portal_path() -> String {
  "/billing/portal".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityBillingPricesConfig {
  #[serde(default = "default_billing_price_type", rename = "type")]
  pub type_name: String,
  #[serde(default)]
  pub amount: Option<i32>,
  #[serde(default)]
  pub yearly_amount: Option<i32>,
  #[serde(default)]
  pub lifetime_amount: Option<i32>,
}

impl Default for CompatibilityBillingPricesConfig {
  fn default() -> Self {
    Self {
      type_name: default_billing_price_type(),
      amount: Some(0),
      yearly_amount: Some(0),
      lifetime_amount: Some(0),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityBillingSubscriptionConfig {
  #[serde(default = "default_billing_subscription_id")]
  pub id: String,
  #[serde(default = "default_billing_active_status")]
  pub default_status: BillingStatus,
  #[serde(default = "default_billing_canceled_status")]
  pub cancel_status: BillingStatus,
  #[serde(default = "default_billing_license_variant")]
  pub variant: Option<BillingVariant>,
}

impl Default for CompatibilityBillingSubscriptionConfig {
  fn default() -> Self {
    Self {
      id: default_billing_subscription_id(),
      default_status: default_billing_active_status(),
      cancel_status: default_billing_canceled_status(),
      variant: default_billing_license_variant(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityBillingLicenseConfig {
  #[serde(default = "default_billing_license_quantity")]
  pub quantity: i32,
  #[serde(default = "default_billing_recurring")]
  pub recurring: BillingRecurring,
  #[serde(default = "default_billing_license_variant")]
  pub variant: Option<BillingVariant>,
}

impl Default for CompatibilityBillingLicenseConfig {
  fn default() -> Self {
    Self {
      quantity: default_billing_license_quantity(),
      recurring: default_billing_recurring(),
      variant: default_billing_license_variant(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityBillingPortalConfig {
  #[serde(default = "default_billing_checkout_path")]
  pub checkout_path: String,
  #[serde(default = "default_billing_customer_portal_path")]
  pub customer_portal_path: String,
}

impl Default for CompatibilityBillingPortalConfig {
  fn default() -> Self {
    Self {
      checkout_path: default_billing_checkout_path(),
      customer_portal_path: default_billing_customer_portal_path(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityBillingConfig {
  #[serde(default = "default_billing_plan")]
  pub plan: BillingPlan,
  #[serde(default = "default_billing_recurring")]
  pub recurring: BillingRecurring,
  #[serde(default = "default_billing_currency")]
  pub currency: String,
  #[serde(default)]
  pub prices: CompatibilityBillingPricesConfig,
  #[serde(default)]
  pub subscription: CompatibilityBillingSubscriptionConfig,
  #[serde(default)]
  pub license: CompatibilityBillingLicenseConfig,
  #[serde(default)]
  pub portal: CompatibilityBillingPortalConfig,
}

impl Default for CompatibilityBillingConfig {
  fn default() -> Self {
    Self {
      plan: default_billing_plan(),
      recurring: default_billing_recurring(),
      currency: default_billing_currency(),
      prices: CompatibilityBillingPricesConfig::default(),
      subscription: CompatibilityBillingSubscriptionConfig::default(),
      license: CompatibilityBillingLicenseConfig::default(),
      portal: CompatibilityBillingPortalConfig::default(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibilityConfig {
  #[serde(default = "default_quota_plan")]
  pub quota_plan: QuotaPlan,
  #[serde(default)]
  pub quota: CompatibilityQuotaConfig,
  #[serde(default)]
  pub billing: CompatibilityBillingConfig,
  #[serde(default)]
  pub features: CompatibilityFeaturesConfig,
}

impl Default for CompatibilityConfig {
  fn default() -> Self {
    Self {
      quota_plan: default_quota_plan(),
      quota: CompatibilityQuotaConfig::default(),
      billing: CompatibilityBillingConfig::default(),
      features: CompatibilityFeaturesConfig::default(),
    }
  }
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthConfig {
  pub google_client_id: Option<String>,
  pub google_client_secret: Option<String>,
  pub github_client_id: Option<String>,
  pub github_client_secret: Option<String>,
  #[serde(default)]
  pub providers: HashMap<String, OAuthCustomProviderConfig>,
}

impl<'de> Deserialize<'de> for OAuthConfig {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    #[derive(Deserialize)]
    struct OAuthConfigSource {
      google_client_id: Option<String>,
      google_client_secret: Option<String>,
      github_client_id: Option<String>,
      github_client_secret: Option<String>,
      #[serde(default)]
      providers: HashMap<String, serde_json::Value>,
    }

    let source = OAuthConfigSource::deserialize(deserializer)?;
    let providers = source
      .providers
      .into_iter()
      .map(|(name, value)| {
        myoxus_contracts::oauth_config::decode_oauth_provider_named(&name, value)
          .map(|provider| {
            let provider = match provider {
              OAuthProviderConfig::Simple(provider) => provider.into(),
              OAuthProviderConfig::Custom(provider) => provider,
            };
            (name, provider)
          })
          .map_err(serde::de::Error::custom)
      })
      .collect::<Result<_, _>>()?;
    Ok(Self {
      google_client_id: source.google_client_id,
      google_client_secret: source.google_client_secret,
      github_client_id: source.github_client_id,
      github_client_secret: source.github_client_secret,
      providers,
    })
  }
}

fn default_cron_tick_interval_seconds() -> u64 {
  30
}

fn default_polling_doc_maintenance_interval_ms() -> u64 {
  120_000
}

fn default_polling_indexer_auto_index_interval_ms() -> u64 {
  30_000
}

fn default_polling_document_graph_reindex_interval_ms() -> u64 {
  30_000
}

fn default_polling_database_projection_interval_ms() -> u64 {
  30_000
}

fn default_polling_database_reminder_interval_ms() -> u64 {
  60_000
}

fn default_polling_workspace_automation_retry_interval_ms() -> u64 {
  30_000
}

fn default_polling_calendar_reminder_interval_ms() -> u64 {
  60_000
}

fn default_polling_caldav_sync_interval_ms() -> u64 {
  // 15 minutes — CalDAV pull-sync poll interval.
  900_000
}

fn default_polling_google_calendar_sync_interval_ms() -> u64 {
  // 15 minutes — Google Calendar pull-sync poll interval.
  900_000
}

fn default_job_attempts() -> u32 {
  5
}

fn default_true() -> bool {
  true
}

fn default_backoff_type() -> String {
  "exponential".to_string()
}

fn default_backoff_delay() -> u64 {
  1000
}

fn default_remove_on_fail_age() -> u64 {
  86400
}

fn default_remove_on_fail_count() -> u32 {
  500
}

/// Typed queue defaults for the BullMQ-compatible job system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobQueueDefaults {
  #[serde(default = "default_job_attempts")]
  pub attempts: u32,
  #[serde(default)]
  pub backoff: JobBackoffConfig,
  #[serde(default = "default_true", rename = "removeOnComplete")]
  pub remove_on_complete: bool,
  #[serde(default, rename = "removeOnFail")]
  pub remove_on_fail: JobRemoveOnFailConfig,
}

impl Default for JobQueueDefaults {
  fn default() -> Self {
    Self {
      attempts: default_job_attempts(),
      backoff: JobBackoffConfig::default(),
      remove_on_complete: default_true(),
      remove_on_fail: JobRemoveOnFailConfig::default(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobBackoffConfig {
  #[serde(default = "default_backoff_type", rename = "type")]
  pub backoff_type: String,
  #[serde(default = "default_backoff_delay")]
  pub delay: u64,
}

impl Default for JobBackoffConfig {
  fn default() -> Self {
    Self {
      backoff_type: default_backoff_type(),
      delay: default_backoff_delay(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRemoveOnFailConfig {
  #[serde(default = "default_remove_on_fail_age")]
  pub age: u64,
  #[serde(default = "default_remove_on_fail_count")]
  pub count: u32,
}

impl Default for JobRemoveOnFailConfig {
  fn default() -> Self {
    Self {
      age: default_remove_on_fail_age(),
      count: default_remove_on_fail_count(),
    }
  }
}

fn default_poll_timeout_seconds() -> u64 {
  5
}

/// Typed worker configuration for the BullMQ-compatible job system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobWorkerDefaults {
  /// Maximum bounded dequeue-poll duration in seconds.
  ///
  /// The worker probes with one atomic Lua transaction every 100 ms during
  /// this window and then checks for configuration changes or shutdown.
  #[serde(default = "default_poll_timeout_seconds", rename = "pollTimeoutSeconds")]
  pub poll_timeout_seconds: u64,
}

impl Default for JobWorkerDefaults {
  fn default() -> Self {
    Self {
      poll_timeout_seconds: default_poll_timeout_seconds(),
    }
  }
}

fn default_job_queue_concurrency() -> i64 {
  1
}

fn default_job_copilot_concurrency() -> i64 {
  2
}

fn default_job_notification_concurrency() -> i64 {
  4
}

fn default_job_indexer_concurrency() -> i64 {
  3
}

fn default_job_calendar_reminder_concurrency() -> i64 {
  2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobQueuePolicyConfig {
  #[serde(default = "default_job_queue_concurrency")]
  pub concurrency: i64,
}

impl Default for JobQueuePolicyConfig {
  fn default() -> Self {
    Self {
      concurrency: default_job_queue_concurrency(),
    }
  }
}

// ─── PDF Export ─────────────────────────────────────────────────────────────

/// Resource limits for the server-side PDF export pipeline.
///
/// Admission, IR, page and compiler limits have distinct owners. Compiler
/// address-space isolation bounds Typst execution; it does not reserve aggregate
/// container memory or bound API-side document materialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PdfExportLimitsConfig {
  /// Reject `exportPdf` mutation when the workspace already has this
  /// many `queued`/`running` jobs that started in the last hour.
  #[serde(default = "default_pdf_max_concurrent_per_workspace")]
  pub max_concurrent_per_workspace: u32,
  /// Maximum block count the IR builder will visit before erroring out.
  /// Caps both per-document complexity and the cost of an individual render.
  #[serde(default = "default_pdf_max_input_blocks")]
  pub max_input_blocks: u32,
  /// Maximum compiled-document page count.  Documents that compile to more
  /// pages than this are rejected after compilation, before PDF serialisation.
  #[serde(default = "default_pdf_max_pages")]
  pub max_pages: u32,
  /// Wall-clock timeout (seconds) for the synchronous Typst render phase.
  /// IR build runs separately and is bounded by `max_input_blocks`.
  #[serde(default = "default_pdf_render_timeout_seconds")]
  pub render_timeout_seconds: u64,
  /// Per-compiler address-space budget in MiB, enforced with hard RLIMIT_AS on
  /// Linux 64-bit before protocol input is decoded. Other platforms fail closed.
  /// This includes mappings/stacks/heap; it is not a resident-memory reservation.
  #[serde(default = "default_pdf_max_memory_mb")]
  pub max_memory_mb: u32,
}

fn default_pdf_max_concurrent_per_workspace() -> u32 {
  3
}
fn default_pdf_max_input_blocks() -> u32 {
  10_000
}
fn default_pdf_max_pages() -> u32 {
  500
}
fn default_pdf_render_timeout_seconds() -> u64 {
  120
}
fn default_pdf_max_memory_mb() -> u32 {
  myoxus_pdf_export::execution::DEFAULT_MEMORY_MB
}

impl Default for PdfExportLimitsConfig {
  fn default() -> Self {
    Self {
      max_concurrent_per_workspace: default_pdf_max_concurrent_per_workspace(),
      max_input_blocks: default_pdf_max_input_blocks(),
      max_pages: default_pdf_max_pages(),
      render_timeout_seconds: default_pdf_render_timeout_seconds(),
      max_memory_mb: default_pdf_max_memory_mb(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PdfExportConfig {
  /// Per-export resource limits.
  pub limits: PdfExportLimitsConfig,
  /// Maximum total size (megabytes) accepted for one uploaded PDF template
  /// bundle. Applies before manifest validation so oversized bundles never
  /// reach the blob store or Typst validator.
  #[serde(default = "default_pdf_max_template_size_mb")]
  pub max_template_size_mb: u32,
  /// Maximum size (megabytes) accepted for one uploaded font binary.
  #[serde(default = "default_pdf_max_font_size_mb")]
  pub max_font_size_mb: u32,
  /// Documents whose IR walk produces at most this many blocks are rendered
  /// synchronously inside the GraphQL mutation and returned with
  /// `status = done` and a usable `download_url` immediately. Larger
  /// documents fall through to the async Redis-queue path.
  ///
  /// Heuristic — ~16 blocks per A4 page at typical density, so a default of
  /// 80 corresponds to roughly a 5-page document (matches ADR §6: "<= 5
  /// Seiten Aequivalent"). Set to `0` to force every job onto the async
  /// queue (used in integration tests that assert queued semantics).
  #[serde(default = "default_pdf_sync_threshold_blocks")]
  pub sync_threshold_blocks: u32,
  /// Maximum size (megabytes) accepted for a single workspace brand logo
  /// upload (PNG or SVG). Exceeding the cap returns a sized error before
  /// the blob store is touched.
  #[serde(default = "default_pdf_max_brand_asset_size_mb")]
  pub max_brand_asset_size_mb: u32,
  /// Image DPI ceiling used by the server-side compression pipeline. This is
  /// intentionally global because templates should not be able to bypass the
  /// anti-DoS raster envelope.
  #[serde(default = "default_pdf_max_dpi")]
  pub max_dpi: u32,
  /// Legacy startup value retained for existing configuration files. PDF
  /// export locale fallback is owned by `i18n.default_locale`.
  #[serde(default = "default_pdf_default_locale")]
  pub default_locale: String,
  /// Server-level fallback when neither L3 input nor workspace brand defaults
  /// provide a page format.
  #[serde(default = "default_pdf_default_paper_size")]
  pub default_paper_size: String,
  /// Server-level fallback when the workspace has no ICC profile override.
  #[serde(default = "default_pdf_default_color_profile")]
  pub default_color_profile: String,
  /// Server-level fallback when neither the export request nor workspace
  /// settings provide an image-quality tier.
  #[serde(default = "default_pdf_default_image_quality")]
  pub default_image_quality: String,
  /// Global Web-CSS-pixel to PDF-point scale for heading typography.
  #[serde(default = "default_pdf_heading_font_scale")]
  pub heading_font_scale: f64,
  /// Global Web-CSS-pixel to PDF-point scale for body, mono and symbol text.
  #[serde(default = "default_pdf_body_font_scale")]
  pub body_font_scale: f64,
  /// Optional veraPDF REST base URL used for explicit PDF/A or PDF/UA validation after
  /// native renderer standards are applied. `None` disables the external gate;
  /// this keeps local stacks usable without the JVM validator container.
  #[serde(default)]
  pub verapdf_validator_url: Option<String>,
  /// Per-request timeout for the external veraPDF validator.
  #[serde(default = "default_pdf_verapdf_timeout_seconds")]
  pub verapdf_timeout_seconds: u64,
  /// Bounds for Edgeless canvas snapshots embedded into PDFs.
  #[serde(default)]
  pub edgeless_snapshot: PdfExportEdgelessSnapshotConfig,
}

fn default_pdf_max_template_size_mb() -> u32 {
  32
}

fn default_pdf_max_font_size_mb() -> u32 {
  16
}

fn default_pdf_sync_threshold_blocks() -> u32 {
  80
}

fn default_pdf_max_brand_asset_size_mb() -> u32 {
  8
}

fn default_pdf_max_dpi() -> u32 {
  600
}

fn default_pdf_default_locale() -> String {
  "en".to_string()
}

fn default_pdf_default_paper_size() -> String {
  "A4".to_string()
}

fn default_pdf_default_color_profile() -> String {
  "sRGB".to_string()
}

fn default_pdf_default_image_quality() -> String {
  "high".to_string()
}

fn default_pdf_heading_font_scale() -> f64 {
  DEFAULT_HEADING_FONT_SCALE
}

fn default_pdf_body_font_scale() -> f64 {
  DEFAULT_BODY_FONT_SCALE
}

fn default_pdf_verapdf_timeout_seconds() -> u64 {
  30
}

impl PdfExportConfig {
  /// Template bundle size cap converted to bytes (overflow-safe).
  pub fn max_template_bytes(&self) -> usize {
    (self.max_template_size_mb as usize).saturating_mul(1_048_576)
  }

  /// Font upload size cap converted to bytes (overflow-safe).
  pub fn max_font_bytes(&self) -> usize {
    (self.max_font_size_mb as usize).saturating_mul(1_048_576)
  }

  /// Brand-asset size cap converted to bytes (overflow-safe).
  pub fn max_brand_asset_bytes(&self) -> u64 {
    (self.max_brand_asset_size_mb as u64).saturating_mul(1_048_576)
  }

  /// Edgeless snapshot caps in the renderer's native unit type.
  pub fn edgeless_snapshot_limits(&self) -> myoxus_pdf_export::EdgelessSnapshotLimits {
    myoxus_pdf_export::EdgelessSnapshotLimits {
      max_canvas_dimension_px: self.edgeless_snapshot.max_dim_px,
      max_canvas_total_pixels: self.edgeless_snapshot.max_total_px,
      max_snapshot_size_bytes: self.edgeless_snapshot.max_size_mb.saturating_mul(1_048_576),
    }
  }
}

impl Default for PdfExportConfig {
  fn default() -> Self {
    Self {
      limits: PdfExportLimitsConfig::default(),
      max_template_size_mb: default_pdf_max_template_size_mb(),
      max_font_size_mb: default_pdf_max_font_size_mb(),
      sync_threshold_blocks: default_pdf_sync_threshold_blocks(),
      max_brand_asset_size_mb: default_pdf_max_brand_asset_size_mb(),
      max_dpi: default_pdf_max_dpi(),
      default_locale: default_pdf_default_locale(),
      default_paper_size: default_pdf_default_paper_size(),
      default_color_profile: default_pdf_default_color_profile(),
      default_image_quality: default_pdf_default_image_quality(),
      heading_font_scale: default_pdf_heading_font_scale(),
      body_font_scale: default_pdf_body_font_scale(),
      verapdf_validator_url: None,
      verapdf_timeout_seconds: default_pdf_verapdf_timeout_seconds(),
      edgeless_snapshot: PdfExportEdgelessSnapshotConfig::default(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PdfExportEdgelessSnapshotConfig {
  /// Maximum width or height in pixels for one encoded canvas snapshot.
  pub max_dim_px: u32,
  /// Maximum total pixels (`width * height`) for one snapshot.
  pub max_total_px: u64,
  /// Maximum encoded PNG size in megabytes for one snapshot.
  pub max_size_mb: usize,
}

impl Default for PdfExportEdgelessSnapshotConfig {
  fn default() -> Self {
    Self {
      max_dim_px: myoxus_pdf_export::EdgelessSnapshotLimits::MAX_CANVAS_DIMENSION_PX,
      max_total_px: myoxus_pdf_export::EdgelessSnapshotLimits::MAX_CANVAS_TOTAL_PIXELS,
      max_size_mb: myoxus_pdf_export::EdgelessSnapshotLimits::MAX_SNAPSHOT_SIZE_BYTES / 1_048_576,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobQueuesConfig {
  #[serde(default = "default_job_copilot_queue")]
  pub copilot: JobQueuePolicyConfig,
  #[serde(default)]
  pub doc: JobQueuePolicyConfig,
  #[serde(default = "default_job_indexer_queue")]
  pub indexer: JobQueuePolicyConfig,
  #[serde(default, rename = "document-graph")]
  pub document_graph: JobQueuePolicyConfig,
  #[serde(default = "default_job_notification_queue")]
  pub notification: JobQueuePolicyConfig,
  #[serde(default)]
  pub nightly: JobQueuePolicyConfig,
  #[serde(default = "default_job_calendar_reminder_queue", rename = "calendar-reminder")]
  pub calendar_reminder: JobQueuePolicyConfig,
  #[serde(default, rename = "git-sync")]
  pub git_sync: JobQueuePolicyConfig,
  #[serde(default, rename = "template-registry")]
  pub template_registry: JobQueuePolicyConfig,
  #[serde(default, rename = "caldav-sync")]
  pub caldav_sync: JobQueuePolicyConfig,
  #[serde(default, rename = "google-calendar-sync")]
  pub google_calendar_sync: JobQueuePolicyConfig,
  #[serde(default, rename = "pdf-export")]
  pub pdf_export: JobQueuePolicyConfig,
  #[serde(default, alias = "workspace-database", alias = "database")]
  pub database: JobQueuePolicyConfig,
  #[serde(default, rename = "workspace-automation")]
  pub workspace_automation: JobQueuePolicyConfig,
  #[serde(default, rename = "workspace-content-operation")]
  pub workspace_content_operation: JobQueuePolicyConfig,
}

fn default_job_copilot_queue() -> JobQueuePolicyConfig {
  JobQueuePolicyConfig {
    concurrency: default_job_copilot_concurrency(),
  }
}

fn default_job_indexer_queue() -> JobQueuePolicyConfig {
  JobQueuePolicyConfig {
    concurrency: default_job_indexer_concurrency(),
  }
}

fn default_job_notification_queue() -> JobQueuePolicyConfig {
  JobQueuePolicyConfig {
    concurrency: default_job_notification_concurrency(),
  }
}

fn default_job_calendar_reminder_queue() -> JobQueuePolicyConfig {
  JobQueuePolicyConfig {
    concurrency: default_job_calendar_reminder_concurrency(),
  }
}

impl Default for JobQueuesConfig {
  fn default() -> Self {
    Self {
      copilot: default_job_copilot_queue(),
      doc: JobQueuePolicyConfig::default(),
      indexer: default_job_indexer_queue(),
      document_graph: JobQueuePolicyConfig::default(),
      notification: default_job_notification_queue(),
      nightly: JobQueuePolicyConfig::default(),
      calendar_reminder: default_job_calendar_reminder_queue(),
      git_sync: JobQueuePolicyConfig::default(),
      template_registry: JobQueuePolicyConfig::default(),
      caldav_sync: JobQueuePolicyConfig::default(),
      google_calendar_sync: JobQueuePolicyConfig::default(),
      pdf_export: JobQueuePolicyConfig::default(),
      database: JobQueuePolicyConfig::default(),
      workspace_automation: JobQueuePolicyConfig::default(),
      workspace_content_operation: JobQueuePolicyConfig::default(),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JobConfig {
  #[serde(default)]
  pub queue: JobQueueDefaults,
  #[serde(default)]
  pub worker: JobWorkerDefaults,
  #[serde(default)]
  pub queues: JobQueuesConfig,
}

/// CronJob polling intervals for recurring background jobs.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerPollingConfig {
  /// Interval (ms) for doc maintenance jobs (`recordPendingDocUpdatesCount`,
  /// `findEmptySummaryDocs`). Default: 120 000 ms (2 min).
  #[serde(default = "default_polling_doc_maintenance_interval_ms")]
  pub doc_maintenance_interval_ms: u64,
  /// Interval (ms) for `indexer.autoIndexWorkspaces`. Default: 30 000 ms (30 s).
  #[serde(default = "default_polling_indexer_auto_index_interval_ms")]
  pub indexer_auto_index_interval_ms: u64,
  /// Interval (ms) for `documentGraph.reindexWorkspaceBatch`. Default: 30 000 ms (30 s).
  #[serde(default = "default_polling_document_graph_reindex_interval_ms")]
  pub document_graph_reindex_interval_ms: u64,
  /// Interval (ms) for Database projection catch-up jobs. Default: 30 000 ms (30 s).
  #[serde(
    default = "default_polling_database_projection_interval_ms",
    alias = "database_projection_interval_ms"
  )]
  pub database_projection_interval_ms: u64,
  /// Interval (ms) for `database.fireReminders`. Default: 60 000 ms.
  #[serde(default = "default_polling_database_reminder_interval_ms")]
  pub database_reminder_interval_ms: u64,
  /// Interval (ms) for retrying failed Workspace Automation runs. Default: 30 000 ms (30 s).
  #[serde(default = "default_polling_workspace_automation_retry_interval_ms")]
  pub workspace_automation_retry_interval_ms: u64,
  /// Interval (ms) for `calendar.enqueueReminders`. Default: 60 000 ms (1 min).
  #[serde(default = "default_polling_calendar_reminder_interval_ms")]
  pub calendar_reminder_interval_ms: u64,
  /// Interval (ms) for `caldav.syncAll` pull-sync. Default: 900 000 ms (15 min).
  #[serde(default = "default_polling_caldav_sync_interval_ms")]
  pub caldav_sync_interval_ms: u64,
  /// Interval (ms) for `googleCalendar.syncAll` pull-sync. Default: 900 000 ms (15 min).
  #[serde(default = "default_polling_google_calendar_sync_interval_ms")]
  pub google_calendar_sync_interval_ms: u64,
}

impl Default for WorkerPollingConfig {
  fn default() -> Self {
    Self {
      doc_maintenance_interval_ms: default_polling_doc_maintenance_interval_ms(),
      indexer_auto_index_interval_ms: default_polling_indexer_auto_index_interval_ms(),
      document_graph_reindex_interval_ms: default_polling_document_graph_reindex_interval_ms(),
      database_projection_interval_ms: default_polling_database_projection_interval_ms(),
      database_reminder_interval_ms: default_polling_database_reminder_interval_ms(),
      workspace_automation_retry_interval_ms: default_polling_workspace_automation_retry_interval_ms(),
      calendar_reminder_interval_ms: default_polling_calendar_reminder_interval_ms(),
      caldav_sync_interval_ms: default_polling_caldav_sync_interval_ms(),
      google_calendar_sync_interval_ms: default_polling_google_calendar_sync_interval_ms(),
    }
  }
}

/// Top-level worker system configuration.
///
/// After the M-JOB-C1 consolidation, only polling intervals and the cron tick
/// remain here. Queue policy lives under `job.*`; both families are
/// materialized once during startup because worker topology and scheduler
/// registration cannot be changed coherently in a running process.
#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct WorkerConfig {
  /// CronJob polling intervals for recurring background jobs.
  #[serde(default)]
  pub polling: WorkerPollingConfig,
  /// Tick interval (seconds) for the cron scheduler loop. Default: 30.
  #[serde(default = "default_cron_tick_interval_seconds")]
  pub cron_tick_interval_seconds: u64,
}

impl OAuthConfig {
  pub fn custom_provider(&self, name: &str) -> Option<&OAuthCustomProviderConfig> {
    let normalized = name.to_ascii_lowercase();
    self.providers.get(&normalized).or_else(|| {
      self
        .providers
        .iter()
        .find_map(|(key, value)| key.eq_ignore_ascii_case(&normalized).then_some(value))
    })
  }

  /// Resolve credentials for a built-in provider from the structured provider
  /// map first, retaining the deployed top-level fields as a fallback. OAuth
  /// login and background consumers must use the same precedence.
  pub fn built_in_provider_credentials(&self, name: &str) -> Option<(&str, &str)> {
    let normalized = name.to_ascii_lowercase();
    if let Some(provider) = self.custom_provider(&normalized) {
      return Some((&provider.client_id, &provider.client_secret));
    }
    match normalized.as_str() {
      "google" => self
        .google_client_id
        .as_deref()
        .zip(self.google_client_secret.as_deref()),
      "github" => self
        .github_client_id
        .as_deref()
        .zip(self.github_client_secret.as_deref()),
      _ => None,
    }
  }

  pub fn is_provider_enabled(&self, name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    match normalized.as_str() {
      "google" | "github" => self.built_in_provider_credentials(&normalized).is_some(),
      _ => self.custom_provider(&normalized).is_some(),
    }
  }
}

fn default_copilot_request_timeout_ms() -> u64 {
  30_000
}

fn default_copilot_embedding_model() -> String {
  "text-embedding-3-small".to_string()
}

fn default_copilot_storage_prefix() -> String {
  "copilot/".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CopilotProviderKind {
  #[serde(alias = "open-ai", alias = "openai")]
  OpenAi,
  Local,
  Custom,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CopilotProviderConfig {
  #[serde(default)]
  pub enabled: bool,
  pub kind: CopilotProviderKind,
  pub endpoint: Option<String>,
  pub api_key: Option<String>,
  #[serde(default)]
  pub models: Vec<String>,
  /// Per-model controls; old models-only configurations retain provider defaults.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub model_options: myoxus_contracts::copilot::CopilotModelOptionsMap,
  #[serde(default = "default_copilot_request_timeout_ms")]
  pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CopilotUnsplashConfig {
  pub key: Option<String>,
}

/// Configuration for the Exa web-search and crawl tools (P100-SRV-H-10a).
///
/// Configuring an executor does not by itself enable native chat tool execution.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CopilotExaConfig {
  /// Exa API key for execution consumers; native chat also needs a continuation owner.
  pub key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CopilotEmbeddingConfig {
  /// OpenAI-compatible embedding API endpoint (e.g. `https://api.openai.com/v1`).
  /// When absent, retrieval is explicitly unavailable; selected context still works.
  pub endpoint: Option<String>,
  /// API key for the embedding endpoint.
  pub api_key: Option<String>,
  /// Embedding model name (default: "text-embedding-3-small").
  #[serde(default = "default_embedding_model")]
  pub model: String,
  /// Expected vector dimension; queries/readiness exclude other dimensions.
  #[serde(default = "default_embedding_dimensions")]
  pub dimensions: u32,
  /// Send task_type=document for indexing and task_type=query for search.
  /// Disabled for standard OpenAI endpoints that do not accept this extension.
  #[serde(default)]
  pub send_task_type: bool,
  /// Number of text chunks to embed in a single API request.
  ///
  /// Larger batches reduce round-trips but increase the risk of hitting
  /// token-limit or payload-size limits (413). Default: 20.
  #[serde(default = "default_embedding_batch_size")]
  pub batch_size: usize,
}

impl Default for CopilotEmbeddingConfig {
  fn default() -> Self {
    Self {
      endpoint: None,
      api_key: None,
      model: default_embedding_model(),
      dimensions: default_embedding_dimensions(),
      send_task_type: false,
      batch_size: default_embedding_batch_size(),
    }
  }
}

fn default_embedding_model() -> String {
  "text-embedding-3-small".to_string()
}

fn default_embedding_dimensions() -> u32 {
  1536
}

fn default_embedding_batch_size() -> usize {
  20
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CopilotConfig {
  /// Global operator switch. Provider readiness remains an independent guard.
  #[serde(default)]
  pub enabled: bool,
  pub default_provider: String,
  #[serde(default)]
  pub fallback_providers: Vec<String>,
  #[serde(default = "default_copilot_request_timeout_ms")]
  pub request_timeout_ms: u64,
  /// Default embedding model used by provider-based embedding calls.
  #[serde(default = "default_copilot_embedding_model")]
  pub embedding_model: String,
  #[serde(default)]
  pub providers: HashMap<String, CopilotProviderConfig>,
  #[serde(default)]
  pub unsplash: CopilotUnsplashConfig,
  /// Exa web-search/crawl integration config (P100-SRV-H-10a).
  #[serde(default)]
  pub exa: CopilotExaConfig,
  #[serde(default)]
  pub embedding: CopilotEmbeddingConfig,
  /// Path prefix for Copilot-generated blobs within the blob storage backend
  /// (P100-SRV-H-09a). All Copilot-produced assets (images, audio transcripts,
  /// etc.) are stored under this prefix so they can be identified and cleaned up
  /// independently of regular user blobs.
  #[serde(default = "default_copilot_storage_prefix")]
  pub storage_prefix: String,
}

impl CopilotConfig {
  /// Preserve literal model IDs and configured precedence. Enabled providers
  /// outside the default chain remain selectable, but never invent a model.
  pub fn chat_providers(&self) -> Vec<(&str, &CopilotProviderConfig)> {
    if !self.enabled {
      return Vec::new();
    }
    let mut remaining = self.providers.keys().map(String::as_str).collect::<Vec<_>>();
    remaining.sort_unstable();
    let mut seen = std::collections::HashSet::new();
    std::iter::once(self.default_provider.as_str())
      .chain(self.fallback_providers.iter().map(String::as_str))
      .chain(remaining)
      .filter(|id| seen.insert(*id))
      .filter_map(|id| {
        self
          .providers
          .get(id)
          .filter(|provider| provider.enabled)
          .map(|provider| (id, provider))
      })
      .collect()
  }

  pub fn chat_models(&self) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    self
      .chat_providers()
      .into_iter()
      .flat_map(|(_, provider)| provider.models.iter())
      .filter(|id| !id.is_empty() && seen.insert((*id).clone()))
      .cloned()
      .collect()
  }
}

impl Default for CopilotConfig {
  fn default() -> Self {
    let mut providers = HashMap::new();
    providers.insert(
      "openai".to_string(),
      CopilotProviderConfig {
        enabled: false,
        kind: CopilotProviderKind::OpenAi,
        endpoint: Some("https://api.openai.com/v1".to_string()),
        api_key: None,
        models: vec![
          "gpt-4.1".to_string(),
          "gpt-4o-mini".to_string(),
          "gpt-4.1-mini".to_string(),
        ],
        model_options: BTreeMap::new(),
        timeout_ms: default_copilot_request_timeout_ms(),
      },
    );
    providers.insert(
      "local".to_string(),
      CopilotProviderConfig {
        enabled: false,
        kind: CopilotProviderKind::Local,
        endpoint: Some("http://localhost:11434/v1".to_string()),
        api_key: None,
        models: vec!["llama3.1".to_string()],
        model_options: BTreeMap::new(),
        timeout_ms: default_copilot_request_timeout_ms(),
      },
    );
    Self {
      enabled: false,
      default_provider: "openai".to_string(),
      fallback_providers: vec!["local".to_string()],
      request_timeout_ms: default_copilot_request_timeout_ms(),
      embedding_model: default_copilot_embedding_model(),
      providers,
      unsplash: CopilotUnsplashConfig::default(),
      exa: CopilotExaConfig::default(),
      embedding: CopilotEmbeddingConfig::default(),
      storage_prefix: default_copilot_storage_prefix(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct CalendarWebhookConfig {
  #[serde(default)]
  pub enabled: bool,
  pub token: Option<String>,
  /// Base URL that Google will use to deliver push notifications.
  ///
  /// Set via `MYOXUS__CALENDAR__GOOGLE_WEBHOOK__WEBHOOK_BASE_URL` or in
  /// `config/local.yaml` under `calendar.google_webhook.webhook_base_url`.
  ///
  /// The full callback URL becomes `{webhook_base_url}/api/calendar/webhook/google`.
  pub webhook_base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct CalendarConfig {
  #[serde(default)]
  pub google_webhook: CalendarWebhookConfig,
  #[serde(default)]
  pub google: Option<serde_json::Value>,
  #[serde(default)]
  pub caldav: Option<serde_json::Value>,
}

// ─── AppConfig modules without dedicated structs ─────────────────────────────

fn default_mcp_enabled() -> bool {
  true
}

fn default_mcp_document_export_max_bytes() -> usize {
  8 * 1024 * 1024
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpConfig {
  #[serde(default = "default_mcp_enabled")]
  pub enabled: bool,
  /// Maximum serialized `read_doc` projection/export envelope size.
  #[serde(
    default = "default_mcp_document_export_max_bytes",
    rename = "documentExportMaxBytes",
    alias = "document_export_max_bytes"
  )]
  pub document_export_max_bytes: usize,
}

impl Default for McpConfig {
  fn default() -> Self {
    Self {
      enabled: default_mcp_enabled(),
      document_export_max_bytes: default_mcp_document_export_max_bytes(),
    }
  }
}

fn default_indexer_batch_size() -> i32 {
  50
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct IndexerConfig {
  #[serde(default)]
  pub enabled: bool,
  #[serde(default)]
  pub provider_type: Option<String>,
  #[serde(default)]
  pub provider_endpoint: Option<String>,
  #[serde(default)]
  pub provider_api_key: Option<String>,
  #[serde(default)]
  pub provider_username: Option<String>,
  #[serde(default)]
  pub provider_password: Option<String>,
  #[serde(default = "default_indexer_batch_size")]
  pub auto_index_batch_size: i32,
}

fn default_captcha_algorithm() -> String {
  // altcha-lib-rs v0.3.x supports SHA-256 (default, widest client-widget
  // compat), SHA-384 and SHA-512.  Argon2id/Scrypt exist only in the JS/Go
  // reference libs and are not available in the Rust port.
  "SHA-256".to_string()
}

fn default_captcha_challenge_expires_seconds() -> u64 {
  1800 // 30 minutes
}

fn default_captcha_max_number() -> u64 {
  50_000 // ~1 s solver time on an average desktop
}

fn default_captcha_rate_limit_per_ip_per_min() -> u32 {
  10
}

fn default_captcha_rate_limit_per_account_per_hour() -> u32 {
  5
}

fn default_captcha_honeypot_field_name() -> String {
  "website".to_string()
}

/// CAPTCHA verification for sign-up, sign-in and password-reset endpoints.
///
/// Uses ALTCHA proof-of-work (self-hosted, no third-party calls, DSGVO-compliant).
/// When `enabled = true`, `hmac_key` MUST be set via `MYOXUS__CAPTCHA__HMAC_KEY`
/// or YAML — otherwise server start-up fails (INV-CAPTCHA-01).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CaptchaConfig {
  /// Master switch.  When false, `/api/auth/challenge` returns 503 and the
  /// verification middleware is a no-op.
  pub enabled: bool,
  /// PoW algorithm.  One of: `SHA-256`, `SHA-384`, `SHA-512`, `Argon2id`, `Scrypt`.
  pub algorithm: String,
  /// HMAC signing key for challenge payloads.  **Sensitive — never log.**
  /// Must be set (≥32 chars recommended) when `enabled = true`.
  pub hmac_key: String,
  /// Maximum age (seconds) of a challenge before verify rejects it.
  pub challenge_expires_seconds: u64,
  /// Upper bound on the solver counter.  Higher = slower solve, better PoW.
  pub max_number: u64,
  /// Per-IP rate limit for sign-up/sign-in/password-reset captcha attempts.
  pub rate_limit_per_ip_per_min: u32,
  /// Per-account rate limit (by e-mail hash) for captcha attempts.
  pub rate_limit_per_account_per_hour: u32,
  /// Honeypot form-field name.  Submissions where this field is non-empty
  /// are rejected (bot trap).
  pub honeypot_field_name: String,
}

impl Default for CaptchaConfig {
  fn default() -> Self {
    Self {
      enabled: false,
      algorithm: default_captcha_algorithm(),
      hmac_key: String::new(),
      challenge_expires_seconds: default_captcha_challenge_expires_seconds(),
      max_number: default_captcha_max_number(),
      rate_limit_per_ip_per_min: default_captcha_rate_limit_per_ip_per_min(),
      rate_limit_per_account_per_hour: default_captcha_rate_limit_per_account_per_hour(),
      honeypot_field_name: default_captcha_honeypot_field_name(),
    }
  }
}

fn default_telemetry_enabled() -> bool {
  true
}
fn default_telemetry_dedupe_ttl() -> u64 {
  1
}
fn default_telemetry_dedupe_max() -> u64 {
  100_000
}
fn default_telemetry_batch_max() -> u32 {
  500
}
fn default_telemetry_flush_interval() -> u64 {
  60
}
fn default_telemetry_retention_raw_days() -> u32 {
  14
}
fn default_telemetry_retention_daily_days() -> u32 {
  90
}
fn default_telemetry_ingest_rate_limit() -> u32 {
  600
}

/// Canonical category names. Keep in sync with the admin GUI toggle grid,
/// `docs/dev/server/telemetry.md` §Category-Model, and
/// `application::telemetry::models::Category`.
pub const TELEMETRY_CATEGORIES: &[&str] = &["page_view", "doc_op", "error", "auth", "admin_action", "ai_interaction"];

fn default_telemetry_categories() -> HashMap<String, bool> {
  TELEMETRY_CATEGORIES.iter().map(|c| ((*c).to_string(), true)).collect()
}

fn default_telemetry_sampling_rates() -> HashMap<String, f32> {
  TELEMETRY_CATEGORIES
    .iter()
    .map(|c| ((*c).to_string(), 1.0_f32))
    .collect()
}

/// Telemetry ingest & retention configuration.
///
/// Design invariants (enforced by tests — see `docs/dev/server/telemetry.md`):
/// - `INV-TEL-03`: `enabled=false` → ingest returns 503.
/// - `INV-TEL-04`: no IPs, e-mails, or names are persisted.
/// - `INV-TEL-05`: user deletion cascades to `telemetry_events.user_id`.
///
/// All GA4 forwarding has been removed (P-Telemetry-A, 2026-04-18): Myoxus
/// is self-hosted, DSGVO-first — no third-party telemetry endpoints.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelemetryConfig {
  /// Master switch. When `false` ingest short-circuits with 503 and no event
  /// is persisted; the HotBuffer, dedupe store, and worker jobs stay idle.
  #[serde(default = "default_telemetry_enabled")]
  pub enabled: bool,

  /// CORS allow-list for the `/api/telemetry/collect` endpoint. Any origin
  /// outside this list is rejected at the CORS layer (before the handler).
  /// An empty list falls back to the global `cors.allowed_origins` set.
  #[serde(default, alias = "allowed_origin")]
  pub allowed_origins: Vec<String>,

  /// TTL for the Redis SETNX dedupe key `telemetry:dedupe:<event_id>`.
  /// One hour is enough to cover retry storms and client reconnects without
  /// bloating the key space.
  #[serde(default = "default_telemetry_dedupe_ttl")]
  pub dedupe_ttl_hours: u64,

  /// Maximum distinct event-ids the dedupe layer tracks in memory before
  /// falling back to a cold-check round-trip.
  #[serde(default = "default_telemetry_dedupe_max")]
  pub dedupe_max_entries: u64,

  /// HotBuffer flush threshold. When the buffer crosses this size the
  /// worker flushes immediately instead of waiting for the next tick.
  #[serde(default = "default_telemetry_batch_max")]
  pub batch_max_events: u32,

  /// Cadence of the scheduled flush (`TelemetryFlushJob`). Lower values
  /// shorten the loss window on shutdown at the cost of more DB round-trips.
  #[serde(default = "default_telemetry_flush_interval")]
  pub flush_interval_seconds: u64,

  /// Raw-event retention. The retention job deletes rows older than this.
  /// Keep it short — raw events may still contain indirect identifiers
  /// even after PII stripping.
  #[serde(default = "default_telemetry_retention_raw_days")]
  pub retention_raw_days: u32,

  /// Daily-rollup retention. Rollups have no `user_id`, so this can be
  /// kept longer without DSGVO concern.
  #[serde(default = "default_telemetry_retention_daily_days")]
  pub retention_daily_days: u32,

  /// Per-category enablement. Keys must be one of [`TELEMETRY_CATEGORIES`].
  /// An unknown category is silently dropped *without* flipping to the
  /// default-allow path — add it to the const first.
  #[serde(default = "default_telemetry_categories")]
  pub categories: HashMap<String, bool>,

  /// Per-category sampling rate in `0.0..=1.0`. The filter keeps an event
  /// with probability `rate`; a value outside bounds is clamped.
  #[serde(default = "default_telemetry_sampling_rates")]
  pub sampling_rates: HashMap<String, f32>,

  /// Per-IP DoS throttle on `/api/telemetry/collect`. Independent of auth
  /// rate-limits and `throttle.enabled`, so a logged-in flood still hits this
  /// gate. Counts requests (one batch is one request) in fixed UTC minute
  /// windows. Values below one are clamped to one. Takes effect on restart.
  #[serde(default = "default_telemetry_ingest_rate_limit")]
  pub ingest_rate_limit_per_ip_per_min: u32,
}

impl Default for TelemetryConfig {
  fn default() -> Self {
    Self {
      enabled: default_telemetry_enabled(),
      allowed_origins: Vec::new(),
      dedupe_ttl_hours: default_telemetry_dedupe_ttl(),
      dedupe_max_entries: default_telemetry_dedupe_max(),
      batch_max_events: default_telemetry_batch_max(),
      flush_interval_seconds: default_telemetry_flush_interval(),
      retention_raw_days: default_telemetry_retention_raw_days(),
      retention_daily_days: default_telemetry_retention_daily_days(),
      categories: default_telemetry_categories(),
      sampling_rates: default_telemetry_sampling_rates(),
      ingest_rate_limit_per_ip_per_min: default_telemetry_ingest_rate_limit(),
    }
  }
}

impl TelemetryConfig {
  /// Returns `true` if `category` is both in `categories` AND enabled.
  /// Unknown categories are considered disabled (fail-closed).
  pub fn category_enabled(&self, category: &str) -> bool {
    self.categories.get(category).copied().unwrap_or(false)
  }

  /// Clamped sampling rate for `category`. Unknown categories return `0.0`
  /// (fail-closed — matches `category_enabled`).
  pub fn sampling_rate(&self, category: &str) -> f32 {
    self
      .sampling_rates
      .get(category)
      .copied()
      .map(|v| v.clamp(0.0, 1.0))
      .unwrap_or(0.0)
  }
}

fn default_ws_transports() -> Vec<String> {
  vec!["websocket".into(), "polling".into()]
}
fn default_ws_max_buffer_mb() -> u64 {
  100 // 100 MB — matches NestJS upstream default
}
fn default_ws_broadcast_channel_capacity() -> usize {
  4096
}
fn default_ws_ping_interval_seconds() -> u64 {
  60
}
fn default_ws_max_connections_per_second_per_client() -> u32 {
  10
}
fn default_eio_ping_interval_seconds() -> u64 {
  60
}
fn default_eio_ping_timeout_seconds() -> u64 {
  120
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebSocketConfig {
  #[serde(default = "default_ws_transports")]
  pub transports: Vec<String>,
  /// Maximum HTTP buffer size in MB. Default 100 MB — matches NestJS upstream.
  ///
  /// **Backwards compatibility**: Also accepts deprecated YAML key `maxHttpBufferSize`.
  /// Values > 1024 are auto-converted from bytes to MB by
  /// `apply_storage_mb_bytes_migration()`.
  #[serde(default = "default_ws_max_buffer_mb", alias = "maxHttpBufferSize")]
  pub max_http_buffer_size_mb: u64,
  /// Capacity of the broadcast channels used for notification and copilot
  /// fan-out.  Higher values reduce the chance of dropped messages under
  /// burst load but consume more memory.
  #[serde(default = "default_ws_broadcast_channel_capacity")]
  pub broadcast_channel_capacity: usize,
  /// Interval in seconds between WebSocket analytics flush ticks.
  #[serde(default = "default_ws_ping_interval_seconds")]
  pub ping_interval_seconds: u64,
  /// Maximum new Socket.IO namespace connections admitted per second for one
  /// client and one account across all API replicas. Existing sockets and
  /// events on them are not counted.
  #[serde(default = "default_ws_max_connections_per_second_per_client")]
  pub max_connections_per_second_per_client: u32,
  /// Engine.IO ping interval in seconds.  The server sends a ping frame every
  /// `eio_ping_interval_seconds`.  Default 60 s — generous enough to survive
  /// browser background-tab timer throttling (Chrome/Firefox throttle to
  /// ≥60 s).  The socketioxide library default (25 s) is too aggressive and
  /// causes spurious disconnects when the tab is inactive.
  #[serde(default = "default_eio_ping_interval_seconds")]
  pub eio_ping_interval_seconds: u64,
  /// Engine.IO ping timeout in seconds.  After sending a ping, the server
  /// waits this long for a pong before disconnecting.  Default 120 s —
  /// browsers in background can delay responses by 60+ seconds.
  #[serde(default = "default_eio_ping_timeout_seconds")]
  pub eio_ping_timeout_seconds: u64,
}

impl Default for WebSocketConfig {
  fn default() -> Self {
    Self {
      transports: default_ws_transports(),
      max_http_buffer_size_mb: default_ws_max_buffer_mb(),
      broadcast_channel_capacity: default_ws_broadcast_channel_capacity(),
      ping_interval_seconds: default_ws_ping_interval_seconds(),
      max_connections_per_second_per_client: default_ws_max_connections_per_second_per_client(),
      eio_ping_interval_seconds: default_eio_ping_interval_seconds(),
      eio_ping_timeout_seconds: default_eio_ping_timeout_seconds(),
    }
  }
}

impl WebSocketConfig {
  /// Convert max_http_buffer_size_mb to bytes (overflow-safe).
  pub fn max_http_buffer_size(&self) -> u64 {
    self.max_http_buffer_size_mb.saturating_mul(1_048_576)
  }
}

fn default_http_proxy_timeout_seconds() -> u64 {
  10
}

/// Configuration for outbound HTTP proxy requests (doc-service proxy,
/// Unsplash API, etc.).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HttpConfig {
  /// Timeout in seconds for outbound proxy HTTP requests (doc-service proxy,
  /// copilot Unsplash proxy).
  #[serde(default = "default_http_proxy_timeout_seconds")]
  pub proxy_timeout_seconds: u64,
}

impl Default for HttpConfig {
  fn default() -> Self {
    Self {
      proxy_timeout_seconds: default_http_proxy_timeout_seconds(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Default, Serialize)]
pub struct FlagsConfig {
  #[serde(default)]
  pub allow_guest_demo_workspace: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CleanupConfig {
  pub history_retention_days: i64,
  pub notification_retention_days: i64,
  pub pending_blob_retention_hours: i64,
  pub outbox_retention_days: i64,
}

impl Default for CleanupConfig {
  fn default() -> Self {
    Self {
      history_retention_days: 30,
      notification_retention_days: 90,
      pending_blob_retention_hours: 24,
      outbox_retention_days: 7,
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct DocumentVersioningConfig {
  pub default_enabled: bool,
  pub default_auto_version_on_pdf_export: bool,
  pub default_retention_count: i32,
}

impl Default for DocumentVersioningConfig {
  fn default() -> Self {
    Self {
      default_enabled: true,
      default_auto_version_on_pdf_export: true,
      default_retention_count: 10,
    }
  }
}

fn default_metrics_enabled() -> bool {
  true
}
fn default_metrics_prometheus_enabled() -> bool {
  true
}
fn default_metrics_persistence_enabled() -> bool {
  true
}
fn default_metrics_flush_interval() -> u64 {
  60
}
fn default_metrics_retention_raw_days() -> u32 {
  7
}
fn default_metrics_retention_daily_days() -> u32 {
  365
}
fn default_metrics_label_workspace_id_enabled() -> bool {
  false
}
fn default_metrics_cardinality_limit_per_metric() -> u32 {
  10_000
}

/// Canonical business-metric category names.  Keep in sync with the admin GUI
/// toggle grid, `docs/dev/server/metrics.md` §Category-Model, and the event
/// hooks in each service.  Adding a new category here is a two-step change
/// (const + hooks) — the config loader uses this slice for default maps.
pub const METRICS_CATEGORIES: &[&str] = &["auth", "workspace", "doc", "collab", "ai", "pdf_export", "mcp"];

fn default_metrics_categories() -> HashMap<String, bool> {
  METRICS_CATEGORIES.iter().map(|c| ((*c).to_string(), true)).collect()
}

/// Persistent business-metrics configuration.
///
/// Design invariants (enforced by tests — see `docs/dev/server/metrics.md`):
/// - `INV-MET-01`: disabled category → business-hook is a no-op.
/// - `INV-MET-02`: existing Prometheus metric names are never renamed.
/// - `INV-MET-06`: cardinality limit is hard-enforced — excess series are
///   dropped and counted in `myoxus_metrics_cardinality_drops_total`.
/// - `INV-MET-07`: `enabled=false` does not affect the process-level
///   `/metrics/prometheus` surface (infrastructure counters always scrape).
///
/// This config is the twin of `TelemetryConfig` but for aggregate counters
/// (no per-event rows, no PII concern).  Business hooks live in the service
/// layer (auth/workspace/doc/collab/ai) and respect the category toggle.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MetricsConfig {
  /// Master switch. When `false` every business-hook is a no-op and the
  /// flush worker idles.  Process-level Prometheus counters keep scraping.
  #[serde(default = "default_metrics_enabled")]
  pub enabled: bool,

  /// Expose business counters on `/metrics/prometheus`.  Decoupled from
  /// `enabled` so an operator can keep the DB pipeline running while
  /// hiding scrape data (e.g. during a noisy rollout).
  #[serde(default = "default_metrics_prometheus_enabled")]
  pub prometheus_enabled: bool,

  /// Persist recorder snapshots to `metrics_raw` / `metrics_daily`.  Turn
  /// off to run Prometheus-only without the DB tables.
  #[serde(default = "default_metrics_persistence_enabled")]
  pub persistence_enabled: bool,

  /// Cadence of the scheduled flush (`MetricsFlushJob`).  Same trade-off as
  /// telemetry — lower = shorter loss window, more DB writes.
  #[serde(default = "default_metrics_flush_interval")]
  pub flush_interval_seconds: u64,

  /// Raw-metric retention.  Minute-granularity rows age out fast — weekly
  /// trends live in the daily rollups.
  #[serde(default = "default_metrics_retention_raw_days")]
  pub retention_raw_days: u32,

  /// Daily-rollup retention.  A year keeps YoY comparisons useful without
  /// unbounded growth.  Set to `0` to disable daily-rollup pruning.
  #[serde(default = "default_metrics_retention_daily_days")]
  pub retention_daily_days: u32,

  /// Per-category enablement.  Keys must be one of [`METRICS_CATEGORIES`].
  /// Unknown keys are silently treated as disabled (fail-closed).
  #[serde(default = "default_metrics_categories")]
  pub categories: HashMap<String, bool>,

  /// When `true` business hooks may add a `workspace_id` label.  Off by
  /// default — in large deployments this blows past the cardinality limit.
  #[serde(default = "default_metrics_label_workspace_id_enabled")]
  pub label_workspace_id_enabled: bool,

  /// Hard upper bound on distinct label-combinations per metric name.
  /// Beyond this the recorder drops the sample and increments a
  /// `myoxus_metrics_cardinality_drops_total` counter so operators see it
  /// on the Prometheus side (INV-MET-06).
  #[serde(default = "default_metrics_cardinality_limit_per_metric")]
  pub cardinality_limit_per_metric: u32,
}

impl Default for MetricsConfig {
  fn default() -> Self {
    Self {
      enabled: default_metrics_enabled(),
      prometheus_enabled: default_metrics_prometheus_enabled(),
      persistence_enabled: default_metrics_persistence_enabled(),
      flush_interval_seconds: default_metrics_flush_interval(),
      retention_raw_days: default_metrics_retention_raw_days(),
      retention_daily_days: default_metrics_retention_daily_days(),
      categories: default_metrics_categories(),
      label_workspace_id_enabled: default_metrics_label_workspace_id_enabled(),
      cardinality_limit_per_metric: default_metrics_cardinality_limit_per_metric(),
    }
  }
}

impl MetricsConfig {
  /// Returns `true` if `category` is both in `categories` AND enabled.
  /// Unknown categories are considered disabled (fail-closed).
  pub fn category_enabled(&self, category: &str) -> bool {
    self.categories.get(category).copied().unwrap_or(false)
  }
}

// ─── Branding ───────────────────────────────────────────────────────────────

fn default_accent_primary() -> String {
  "#1E96EB".to_string()
}
fn default_accent_secondary() -> String {
  "#0A6DCA".to_string()
}
fn default_logo_url() -> String {
  "/style/logo.svg".to_string()
}
fn default_branding_style_dir() -> String {
  "./client-style".to_string()
}
fn default_branding_max_upload_mb() -> u64 {
  1 // 1 MB
}

/// Runtime branding configuration: accent colours, logo/product-mark asset
/// URLs, and upload constraints.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct BrandingConfig {
  /// Primary accent colour (CSS hex, e.g. `#1E96EB`).
  #[serde(default = "default_accent_primary")]
  pub accent_primary: String,
  /// Secondary accent colour (CSS hex, e.g. `#0A6DCA`).
  #[serde(default = "default_accent_secondary")]
  pub accent_secondary: String,
  /// Primary accent colour for dark mode (defaults to `accent_primary` if empty).
  #[serde(default)]
  pub accent_primary_dark: String,
  /// Secondary accent colour for dark mode (defaults to `accent_secondary` if empty).
  #[serde(default)]
  pub accent_secondary_dark: String,
  /// URL path to the logo SVG (relative, served by Nginx).
  #[serde(default = "default_logo_url")]
  pub logo_url: String,
  /// URL path to the product-mark SVG (optional).
  #[serde(default)]
  pub product_mark_url: String,
  /// Filesystem directory where uploaded branding assets are written.
  #[serde(default = "default_branding_style_dir")]
  pub style_dir: String,
  /// Maximum upload size in MB for branding assets.
  #[serde(default = "default_branding_max_upload_mb", alias = "max_upload_bytes")]
  pub max_upload_mb: u64,
  // Theme, typography and editor font choices are stored in the server-owned
  // branding tables seeded by `myoxus_infrastructure::branding`.
}

impl Default for BrandingConfig {
  fn default() -> Self {
    Self {
      accent_primary: default_accent_primary(),
      accent_secondary: default_accent_secondary(),
      accent_primary_dark: String::new(),
      accent_secondary_dark: String::new(),
      logo_url: default_logo_url(),
      product_mark_url: String::new(),
      style_dir: default_branding_style_dir(),
      max_upload_mb: default_branding_max_upload_mb(),
    }
  }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppConfig {
  /// Sanitized startup-source provenance shared by Admin/runtime projections.
  /// It is populated by [`AppConfig::load`] and never deserialized from YAML.
  #[serde(skip)]
  pub source_snapshot: ConfigSourceSnapshot,
  /// Immutable bootstrap trust injected before network composition. Never
  /// deserialize or reload it from effective configuration or database rows.
  #[serde(skip)]
  pub additional_ca: Option<myoxus_infrastructure::tls::ValidatedCaBundle>,
  pub server: ServerConfig,
  pub database: DatabaseConfig,
  #[serde(default)]
  pub redis: RedisConfig,
  #[serde(default)]
  pub crypto: CryptoConfig,
  #[serde(default)]
  pub throttle: ThrottleConfig,
  #[serde(default)]
  pub auth: AuthConfig,
  pub mail: MailConfig,
  #[serde(default)]
  pub templates: TemplatesConfig,
  pub storage: StorageConfig,
  #[serde(default)]
  pub doc: DocConfig,
  #[serde(default)]
  pub doc_service: DocServiceConfig,
  #[serde(default)]
  pub client: ClientConfig,
  #[serde(default)]
  pub i18n: I18nConfig,
  #[serde(default)]
  pub admin_i18n: AdminI18nConfig,
  pub oauth: OAuthConfig,
  #[serde(default)]
  pub copilot: CopilotConfig,
  #[serde(default)]
  pub transcription: TranscriptionConfig,
  #[serde(default)]
  pub calendar: CalendarConfig,
  #[serde(default)]
  pub job: JobConfig,
  #[serde(default)]
  pub worker: WorkerConfig,
  #[serde(default)]
  pub logging: LoggingConfig,
  #[serde(default)]
  pub public_publishing: PublicPublishingConfig,
  #[serde(default)]
  pub preview: PreviewConfig,
  #[serde(default)]
  pub compat: CompatibilityConfig,
  #[serde(default)]
  pub mcp: McpConfig,
  #[serde(default)]
  pub indexer: IndexerConfig,
  #[serde(default)]
  pub captcha: CaptchaConfig,
  #[serde(default)]
  pub telemetry: TelemetryConfig,
  #[serde(default)]
  pub websocket: WebSocketConfig,
  #[serde(default)]
  pub flags: FlagsConfig,
  #[serde(default)]
  pub cleanup: CleanupConfig,
  #[serde(default)]
  pub document_versioning: DocumentVersioningConfig,
  #[serde(default)]
  pub metrics: MetricsConfig,
  #[serde(default)]
  pub branding: BrandingConfig,
  #[serde(default)]
  pub git_sync: GitSyncPolicyConfig,
  #[serde(default)]
  pub tls: myoxus_contracts::runtime_config::TlsConfig,
  #[serde(default)]
  pub journal: JournalConfig,
  #[serde(default)]
  pub databases: DatabasesConfig,
  #[serde(default)]
  pub workspace: WorkspaceConfig,
  #[serde(default)]
  pub workspace_automation: WorkspaceAutomationConfig,
  #[serde(default)]
  pub document_graph: DocumentGraphConfig,
  #[serde(default)]
  pub cors: CorsConfig,
  #[serde(default)]
  pub http: HttpConfig,
  #[serde(default)]
  pub template_registry: TemplateRegistryConfig,
  #[serde(default)]
  pub pdf_export: PdfExportConfig,
  #[serde(default)]
  pub cache: crate::cache::CacheConfig,
}

/// Limits for server-backed Databases.
///
/// These values are materialized at startup and deliberately marked
/// restart-required in the Admin config registry: the database service receives
/// a snapshot of this struct during API state wiring.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DatabasesConfig {
  pub max_fields_per_database: usize,
  pub max_views_per_database: usize,
  pub default_rows_per_page: i64,
  pub max_rows_per_page: i64,
  pub max_cell_text_bytes: usize,
  pub csv_max_bytes: usize,
  pub csv_max_rows: usize,
  pub csv_max_columns: usize,
  pub csv_sample_rows_for_type_inference: usize,
  /// Hard byte cap on Notion HTML/ZIP import payloads (P-DB-29).
  pub notion_max_bytes: usize,
  pub reminder_batch_size: i64,
  pub max_reminders_per_user_per_cell: usize,
  pub max_reminder_offset_minutes: i64,
}

impl Default for DatabasesConfig {
  fn default() -> Self {
    Self {
      max_fields_per_database: 100,
      max_views_per_database: 25,
      default_rows_per_page: 100,
      max_rows_per_page: 500,
      max_cell_text_bytes: 16_384,
      csv_max_bytes: 5_242_880,
      csv_max_rows: 10_000,
      csv_max_columns: 100,
      csv_sample_rows_for_type_inference: 100,
      notion_max_bytes: 67_108_864,
      reminder_batch_size: 100,
      max_reminders_per_user_per_cell: 5,
      max_reminder_offset_minutes: 525_600,
    }
  }
}

/// Live server-owned speech configuration. Credentials never enter job snapshots.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct TranscriptionConfig {
  pub enabled: bool,
  pub endpoint: String,
  pub model: String,
  pub api_key: Option<String>,
  pub language: Option<String>,
  pub request_timeout_ms: u64,
  pub max_input_bytes: u64,
  pub max_response_bytes: usize,
  pub max_duration_seconds: u64,
  pub max_concurrency: usize,
}

impl Default for TranscriptionConfig {
  fn default() -> Self {
    Self {
      enabled: false,
      endpoint: String::new(),
      model: String::new(),
      api_key: None,
      language: None,
      request_timeout_ms: 120_000,
      max_input_bytes: 104_857_600,
      max_response_bytes: 16_777_216,
      max_duration_seconds: 7200,
      max_concurrency: 2,
    }
  }
}

impl std::fmt::Debug for TranscriptionConfig {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("TranscriptionConfig")
      .field("enabled", &self.enabled)
      .field("endpoint", &self.endpoint)
      .field("model", &self.model)
      .field("api_key", &self.api_key.as_ref().map(|_| "***REDACTED***"))
      .field("language", &self.language)
      .finish_non_exhaustive()
  }
}

impl TranscriptionConfig {
  pub fn configured(&self) -> bool {
    !self.endpoint.trim().is_empty() && !self.model.trim().is_empty()
  }
  /// Non-secret admission values stored in the existing durable job payload.
  pub fn execution_snapshot(&self) -> myoxus_application::transcription::TranscriptionExecutionConfig {
    myoxus_application::transcription::TranscriptionExecutionConfig {
      source: self.endpoint.trim_end_matches('/').to_string(),
      model: self.model.clone(),
      language: self.language.clone(),
      request_timeout_ms: self.request_timeout_ms,
      max_input_bytes: self.max_input_bytes,
      max_response_bytes: self.max_response_bytes,
      max_duration_seconds: self.max_duration_seconds,
      max_concurrency: self.max_concurrency,
    }
  }
}

/// Server-owned configuration for account/workspace operations.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkspaceConfig {
  #[serde(rename = "import")]
  pub r#import: WorkspaceImportConfig,
}

/// Limits for server-owned Workspace Automations.
///
/// These values are materialized at API/worker start into
/// `WorkspaceAutomationLimits`; Admin marks them restart-required because runs
/// must keep stable retry, rate-limit and action-count envelopes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceAutomationConfig {
  pub enabled: bool,
  pub max_actions_per_run: usize,
  pub max_runs_per_minute: i64,
  pub webhook_timeout_seconds: u64,
  pub max_retry_attempts: i32,
}

impl Default for WorkspaceAutomationConfig {
  fn default() -> Self {
    Self {
      enabled: true,
      max_actions_per_run: 25,
      max_runs_per_minute: 300,
      webhook_timeout_seconds: 10,
      max_retry_attempts: 5,
    }
  }
}

/// Limits for the server-authoritative Document Graph.
///
/// These values are materialized at API/worker start into
/// `DocumentGraphLimits`; Admin marks them restart-required because live
/// reindex jobs must keep a stable extraction and redaction envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentGraphConfig {
  pub max_graph_nodes: usize,
  pub max_graph_edges: usize,
  pub max_occurrences_per_edge: usize,
  pub max_reindex_batch: i64,
  pub max_catch_up_workspaces: i64,
  pub preview_max_chars: usize,
  pub stale_after_seconds: i64,
  pub enqueue_delay_ms: i64,
  pub max_reindex_attempts: i32,
}

impl Default for DocumentGraphConfig {
  fn default() -> Self {
    Self {
      max_graph_nodes: 250,
      max_graph_edges: 500,
      max_occurrences_per_edge: 25,
      max_reindex_batch: 100,
      max_catch_up_workspaces: 25,
      preview_max_chars: 256,
      stale_after_seconds: 300,
      enqueue_delay_ms: 0,
      max_reindex_attempts: 5,
    }
  }
}

/// CORS configuration.
///
/// The CORS layer always allows the server's own `server.origin` plus any
/// origins whose scheme matches an entry in `app_origins` (Desktop/Electron/
/// Tauri/Capacitor apps).  Additional web origins can be added via
/// `allowed_origins`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CorsConfig {
  /// Additional allowed origins beyond `server.origin` and app origins.
  pub allowed_origins: Vec<String>,
  /// `Access-Control-Max-Age` in seconds (default: 86400 = 1 day).
  pub max_age_seconds: u64,
  /// URI schemes (or literal values like `"null"`) that are always accepted
  /// as app origins.  An incoming `Origin` header is accepted when it equals
  /// an entry or starts with one (prefix match).
  #[serde(default = "default_cors_app_origins")]
  pub app_origins: Vec<String>,
  /// Custom HTTP headers allowed in CORS requests (in addition to the
  /// always-allowed `Content-Type`, `Authorization`, and `Cookie`).
  #[serde(default = "default_cors_custom_headers")]
  pub allowed_custom_headers: Vec<String>,
}

fn default_cors_app_origins() -> Vec<String> {
  vec![
    "file://".into(),
    "null".into(),
    "app://".into(),
    "assets://".into(),
    "myoxus-app://".into(),
    "tauri://".into(),
    "myoxus://".into(),
    "capacitor://".into(),
  ]
}

fn default_cors_custom_headers() -> Vec<String> {
  vec![
    "x-myoxus-version".into(),
    "x-myoxus-client".into(),
    "x-myoxus-client-format".into(),
    "x-myoxus-client-capabilities".into(),
    "x-myoxus-csrf-token".into(),
    "x-affine-version".into(),
    "x-request-id".into(),
    "x-operation-name".into(),
    "x-definition-name".into(),
    "x-apollo-operation-name".into(),
  ]
}

impl Default for CorsConfig {
  fn default() -> Self {
    Self {
      allowed_origins: Vec::new(),
      max_age_seconds: 86400,
      app_origins: default_cors_app_origins(),
      allowed_custom_headers: default_cors_custom_headers(),
    }
  }
}

/// Journal display settings configurable by the server administrator.
///
/// These are global defaults; individual users can override them in their
/// personal settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct JournalConfig {
  /// Show ISO calendar week numbers in the journal month view.
  pub show_calendar_weeks: bool,
  /// First day of the week: "monday" or "sunday".
  pub first_day_of_week: String,
  /// Enable the native journal calendar feature (P-JCAL).
  /// Default true; set false to hide the calendar UI until the quality gate passes.
  #[serde(default = "default_journal_calendar_enabled")]
  pub calendar_enabled: bool,
}

fn default_journal_calendar_enabled() -> bool {
  true
}

impl Default for JournalConfig {
  fn default() -> Self {
    Self {
      show_calendar_weeks: true,
      first_day_of_week: "monday".to_string(),
      calendar_enabled: default_journal_calendar_enabled(),
    }
  }
}

// ─── Template Registry ───────────────────────────────────────────────────────

fn default_template_registry_enabled() -> bool {
  false
}

fn default_template_registry_import_max_bundle_size_mb() -> u64 {
  50
}

fn default_template_registry_reconcile_default_mode() -> String {
  "managed_until_local_edit".to_string()
}

fn default_template_registry_builtin_bridge_enabled() -> bool {
  true
}

fn default_template_registry_drift_scan_enabled() -> bool {
  true
}

fn default_template_registry_drift_scan_interval_seconds() -> u64 {
  3600
}

fn default_template_registry_zip_max_entries() -> u64 {
  256
}

fn default_template_registry_zip_max_total_uncompressed_size_mb() -> u64 {
  200
}

fn default_template_registry_zip_max_entry_uncompressed_size_mb() -> u64 {
  50
}

fn default_template_registry_zip_max_compression_ratio() -> f64 {
  200.0
}

fn default_template_registry_zip_max_path_length() -> u64 {
  512
}

/// ZIP archive safety limits used while importing template bundles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TemplateRegistryZipLimitsConfig {
  /// Maximum number of ZIP entries accepted in a single template bundle.
  #[serde(default = "default_template_registry_zip_max_entries")]
  pub max_entries: u64,
  /// Maximum combined uncompressed size of all ZIP entries, in MB.
  #[serde(default = "default_template_registry_zip_max_total_uncompressed_size_mb")]
  pub max_total_uncompressed_size_mb: u64,
  /// Maximum uncompressed size of any single ZIP entry, in MB.
  #[serde(default = "default_template_registry_zip_max_entry_uncompressed_size_mb")]
  pub max_entry_uncompressed_size_mb: u64,
  /// Maximum allowed uncompressed-to-compressed ratio per ZIP entry.
  #[serde(default = "default_template_registry_zip_max_compression_ratio")]
  pub max_compression_ratio: f64,
  /// Maximum path length accepted for a ZIP entry.
  #[serde(default = "default_template_registry_zip_max_path_length")]
  pub max_path_length: u64,
}

impl Default for TemplateRegistryZipLimitsConfig {
  fn default() -> Self {
    Self {
      max_entries: default_template_registry_zip_max_entries(),
      max_total_uncompressed_size_mb: default_template_registry_zip_max_total_uncompressed_size_mb(),
      max_entry_uncompressed_size_mb: default_template_registry_zip_max_entry_uncompressed_size_mb(),
      max_compression_ratio: default_template_registry_zip_max_compression_ratio(),
      max_path_length: default_template_registry_zip_max_path_length(),
    }
  }
}

/// Template Registry configuration.
///
/// Controls the centrally administered template feature for shared workspaces.
/// Templates are imported as bundles, versioned, assigned to workspaces via
/// policies, and materialized as normal workspace documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TemplateRegistryConfig {
  /// Master switch: when false, the template registry feature is completely disabled.
  #[serde(default = "default_template_registry_enabled")]
  pub enabled: bool,
  /// Maximum size in MB for uploaded template bundles. Default: 50 MB.
  #[serde(default = "default_template_registry_import_max_bundle_size_mb")]
  pub import_max_bundle_size_mb: u64,
  /// ZIP archive safety limits applied during template bundle import.
  #[serde(default)]
  pub zip_limits: TemplateRegistryZipLimitsConfig,
  /// Default provisioning mode for new template assignments.
  /// Valid values: "seed_once", "managed_until_local_edit", "manual_update".
  #[serde(default = "default_template_registry_reconcile_default_mode")]
  pub reconcile_default_mode: String,
  /// Enable the Builtin Bridge feature (P125-TPL). When false, builtin templates
  /// are not seeded and reconcile endpoints return empty lists.
  #[serde(default = "default_template_registry_builtin_bridge_enabled")]
  pub builtin_bridge_enabled: bool,
  /// Whether automatic drift scanning is enabled.
  #[serde(default = "default_template_registry_drift_scan_enabled")]
  pub drift_scan_enabled: bool,
  /// Interval in seconds between automatic drift scans. Default: 3600 (1 hour).
  #[serde(default = "default_template_registry_drift_scan_interval_seconds")]
  pub drift_scan_interval_seconds: u64,
}

impl Default for TemplateRegistryConfig {
  fn default() -> Self {
    Self {
      enabled: default_template_registry_enabled(),
      import_max_bundle_size_mb: default_template_registry_import_max_bundle_size_mb(),
      zip_limits: TemplateRegistryZipLimitsConfig::default(),
      reconcile_default_mode: default_template_registry_reconcile_default_mode(),
      builtin_bridge_enabled: default_template_registry_builtin_bridge_enabled(),
      drift_scan_enabled: default_template_registry_drift_scan_enabled(),
      drift_scan_interval_seconds: default_template_registry_drift_scan_interval_seconds(),
    }
  }
}

/// Global Git Sync policy configuration managed by the server administrator.
///
/// Controls which Git Sync features are available to workspace users.
/// The web frontend reads these policies to restrict the profile form
/// (P21-13b direction switches, P21-14c feature flags).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GitSyncPolicyConfig {
  /// Terminal SQL history age, in days. Operational identity and unfinished
  /// recovery never expire merely because this cutoff has passed.
  pub retention_days: u32,
  /// Master switch: when false, Git Sync is completely hidden from all users.
  pub enabled: bool,
  /// Allowed sync directions. Users can only select from these options.
  /// Values: "bidirectional", "myoxus_to_git", "git_to_myoxus"
  pub allowed_directions: Vec<String>,
  /// Allowed authentication methods. Users can only use these.
  /// Values: "https_token", "https_password", "ssh_key"
  pub allowed_auth_methods: Vec<String>,
  /// Allowed Git hosts. Empty list = all hosts allowed.
  /// Example: ["github.com", "gitlab.com", "git.company.de"]
  pub allowed_hosts: Vec<String>,
  /// Default branch name pre-filled in the profile form.
  pub default_branch: String,
  /// Whether automatic (polling/webhook) sync is allowed.
  pub auto_sync_allowed: bool,
  /// Whether webhook-triggered sync is allowed.
  pub webhook_allowed: bool,
  /// SSH host-key verification mode for git2 SSH transports.
  #[serde(default)]
  pub ssh_host_key_policy: SshHostKeyPolicy,
  /// HTTPS X509 verification mode for git2 HTTPS transports.
  #[serde(default)]
  pub https_certificate_policy: HttpsCertificatePolicy,
  /// Optional CA bundle path relative to the active runtime-config directory.
  ///
  /// The bundle is materialized once during startup because libgit2 exposes
  /// its CA location as a process-global option.
  #[serde(default)]
  pub https_ca_bundle_path: Option<String>,
  /// Shared HMAC secret for Git-Sync webhooks.
  ///
  /// This is intentionally YAML/ENV-only and skipped during serialization so it
  /// never appears in admin config export/API responses. Set via
  /// `MYOXUS__GIT_SYNC__WEBHOOK_SECRET`.
  #[serde(default, skip_serializing)]
  pub webhook_secret: Option<String>,
  /// Timeout in seconds for git network operations (clone, fetch, push). Default: 120.
  #[serde(default = "default_git_network_timeout_secs")]
  pub network_timeout_secs: u64,
  /// Timeout in seconds for git local operations (checkout, commit). Default: 30.
  #[serde(default = "default_git_local_timeout_secs")]
  pub local_timeout_secs: u64,
  /// Base directory for cloned repositories. Default: system temp dir.
  #[serde(default = "default_git_repo_base_dir")]
  pub repo_base_dir: String,
  /// Maximum number of docs to load per sync run. 0 = unlimited.
  /// Prevents OOM on workspaces with thousands of large documents.
  #[serde(default = "default_git_max_docs_per_sync")]
  pub max_docs_per_sync: usize,
  /// Shallow clone/fetch depth. Default: 1. Must be positive; full clones are
  /// intentionally not exposed by runtime config because mirror growth is an
  /// operational safety concern.
  #[serde(default = "default_git_clone_depth")]
  pub clone_depth: u32,
  /// Maximum push retry attempts before failing. Default: 1.
  #[serde(default = "default_git_push_max_retries")]
  pub push_max_retries: u32,
  /// Git commit author name for sync commits. Default: "Myoxus Sync".
  #[serde(default = "default_git_commit_author_name")]
  pub commit_author_name: String,
  /// Git commit author email for sync commits. Default: "sync@myoxus.local".
  #[serde(default = "default_git_commit_author_email")]
  pub commit_author_email: String,
  /// Number of docs above which Yjs conversion switches to parallel mode. Default: 10.
  #[serde(default = "default_git_parallel_conversion_threshold")]
  pub parallel_conversion_threshold: usize,
  /// Maximum total size in MB for all local git mirror repos. Default: 1024 (1 GB).
  /// Set to 0 for unlimited. Pre-flight check before clone/fetch.
  #[serde(default = "default_git_max_mirror_storage_mb")]
  pub max_mirror_storage_mb: u64,
  /// Minimum free disk space in MB required before clone/fetch. Default: 500.
  #[serde(default = "default_git_min_free_disk_mb")]
  pub min_free_disk_mb: u64,
  /// TTL in seconds for the per-profile distributed sync lock (Redis SETNX).
  /// Default: 300 (5 minutes).
  ///
  /// Must be greater than the maximum expected sync duration: if a lock
  /// expires while the holder is still syncing, another instance can
  /// acquire the lock and run a concurrent sync against the same
  /// remote, leading to push collisions and divergent state. Operators
  /// running large workspaces (high `max_docs_per_sync`, large
  /// repositories) should increase this value to safely cover the
  /// 99th-percentile sync wall-clock time. ROB-26.
  #[serde(default = "default_git_lock_ttl_seconds")]
  pub lock_ttl_seconds: u64,
  /// Admin-managed MIME type allowlist for git-sync file uploads.
  /// Files with MIME types not on this list are subject to the validation mode.
  /// Supports wildcards (e.g. "image/*").
  #[serde(default = "default_git_mime_allowlist_admin")]
  pub mime_allowlist_admin: Vec<String>,
  /// Admin-managed MIME type blocklist for git-sync file uploads.
  /// Blocklist takes priority over allowlist.
  #[serde(default)]
  pub mime_blocklist_admin: Vec<String>,
  /// MIME validation enforcement mode. "strict" = deny disallowed types, "warn" = allow but log.
  #[serde(default = "default_git_mime_validation_mode")]
  pub mime_validation_mode: String,
}

fn default_git_max_docs_per_sync() -> usize {
  0 // unlimited
}

fn default_git_clone_depth() -> u32 {
  1
}

fn default_git_push_max_retries() -> u32 {
  1
}

fn default_git_commit_author_name() -> String {
  "Myoxus Sync".to_string()
}

fn default_git_commit_author_email() -> String {
  "sync@myoxus.local".to_string()
}

fn default_git_parallel_conversion_threshold() -> usize {
  10
}

fn default_git_max_mirror_storage_mb() -> u64 {
  1024
}

fn default_git_min_free_disk_mb() -> u64 {
  500
}

/// Default per-profile distributed sync lock TTL (5 minutes). ROB-26.
///
/// Matches the previous hardcoded `REDIS_LOCK_TTL_SECS` constant in
/// `crates/api/src/git_sync_engine/locking.rs`. Operators running long
/// syncs (large repositories, high `max_docs_per_sync`) should
/// override this in YAML / admin GUI to cover their 99th-percentile
/// sync wall-clock — otherwise a long-running sync can lose its lock
/// mid-flight and another instance starts a concurrent run against
/// the same remote.
fn default_git_lock_ttl_seconds() -> u64 {
  300
}

fn default_git_mime_allowlist_admin() -> Vec<String> {
  vec![
    "image/png".to_string(),
    "image/jpeg".to_string(),
    "image/webp".to_string(),
    "image/svg+xml".to_string(),
    "application/pdf".to_string(),
    "text/plain".to_string(),
    "text/markdown".to_string(),
    "application/json".to_string(),
    "application/yaml".to_string(),
    "application/zip".to_string(),
  ]
}

fn default_git_mime_validation_mode() -> String {
  "warn".to_string()
}

fn default_git_network_timeout_secs() -> u64 {
  120
}

fn default_git_local_timeout_secs() -> u64 {
  30
}

fn default_git_repo_base_dir() -> String {
  "./storage/git-sync".to_string()
}

impl Default for GitSyncPolicyConfig {
  fn default() -> Self {
    Self {
      retention_days: 7,
      enabled: true,
      allowed_directions: vec![
        "bidirectional".to_string(),
        "myoxus_to_git".to_string(),
        "git_to_myoxus".to_string(),
      ],
      allowed_auth_methods: vec!["https_token".to_string(), "ssh_key".to_string()],
      allowed_hosts: vec![],
      default_branch: "main".to_string(),
      auto_sync_allowed: true,
      webhook_allowed: false,
      ssh_host_key_policy: SshHostKeyPolicy::AcceptNew,
      https_certificate_policy: HttpsCertificatePolicy::Strict,
      https_ca_bundle_path: None,
      webhook_secret: None,
      network_timeout_secs: default_git_network_timeout_secs(),
      local_timeout_secs: default_git_local_timeout_secs(),
      repo_base_dir: default_git_repo_base_dir(),
      max_docs_per_sync: default_git_max_docs_per_sync(),
      clone_depth: default_git_clone_depth(),
      push_max_retries: default_git_push_max_retries(),
      commit_author_name: default_git_commit_author_name(),
      commit_author_email: default_git_commit_author_email(),
      parallel_conversion_threshold: default_git_parallel_conversion_threshold(),
      max_mirror_storage_mb: default_git_max_mirror_storage_mb(),
      min_free_disk_mb: default_git_min_free_disk_mb(),
      lock_ttl_seconds: default_git_lock_ttl_seconds(),
      mime_allowlist_admin: default_git_mime_allowlist_admin(),
      mime_blocklist_admin: vec![],
      mime_validation_mode: default_git_mime_validation_mode(),
    }
  }
}

/// Emit a startup warning for each deprecated telemetry key still present
/// in YAML/ENV. The key is silently dropped by serde (unknown to the new
/// struct shape), so without this warning operators would never notice.
///
/// Deprecated in P-Telemetry-A (2026-04-18) — GA4 forwarding removed.
fn warn_deprecated_telemetry_keys(cfg: &Config) {
  for key in &["telemetry.ga4_measurement_id", "telemetry.ga4_api_secret"] {
    if cfg.get::<Option<serde_json::Value>>(key).ok().flatten().is_some() {
      push_startup_warning(format!(
        "[config] deprecated key `{}` is ignored — GA4 forwarding was removed \
         in P-Telemetry-A (2026-04-18). Remove it from your YAML/ENV. See \
         docs/dev/server/telemetry.md for the replacement DSGVO-compliant pipeline.",
        key
      ));
    }
  }
  // `telemetry.allowed_origin` (singular) is renamed to `allowed_origins`.
  // Kept as a serde alias, so it still works, but warn on the old name so
  // it can eventually be cleaned up.
  if cfg
    .get::<Option<serde_json::Value>>("telemetry.allowed_origin")
    .ok()
    .flatten()
    .is_some()
  {
    push_startup_warning(
      "[config] `telemetry.allowed_origin` is deprecated — rename to \
       `telemetry.allowed_origins` (the old name is still accepted as an \
       alias, but will be removed in a future release).",
    );
  }
}

/// Warn when operators still use the pre-P-DB-01 Database config names.
///
/// Serde aliases keep existing deployments bootable, but the emitted runtime
/// config, Admin config registry, queue names and worker jobs use the canonical
/// `database`/`databases` naming. Keeping this warning beside the existing
/// startup-warning path makes YAML and environment drift visible without
/// inventing a second config deprecation system.
fn warn_deprecated_database_config_keys(cfg: &Config) {
  for (deprecated, replacement) in [
    ("database", "databases"),
    ("database", "databases"),
    ("job.queues.workspace-database", "job.queues.database"),
    (
      "worker.polling.database_projection_interval_ms",
      "worker.polling.database_projection_interval_ms",
    ),
  ] {
    if cfg
      .get::<Option<serde_json::Value>>(deprecated)
      .ok()
      .flatten()
      .is_some()
    {
      push_startup_warning(format!(
        "[config] `{deprecated}` is deprecated — rename to `{replacement}`. \
         The old key is accepted as an alias during the P-DB-01 Database naming transition."
      ));
    }
  }
}

impl AppConfig {
  pub fn load() -> Result<Self, ConfigError> {
    let sources = load_server_config_sources()?;
    Self::from_loaded_sources(sources, true)
  }

  /// Resolves configured values for the next startup without applying runtime
  /// changes or performing startup-owned writes (for example secret bootstrap).
  pub(crate) fn configured_baseline() -> Result<Self, ConfigError> {
    Self::from_loaded_sources(load_server_config_sources()?, false)
  }

  fn from_loaded_sources(sources: ServerConfigSources, startup_effects: bool) -> Result<Self, ConfigError> {
    if startup_effects && sources.defaulted_run_mode {
      // SC-L-03: Log when using default RUN_MODE so operators notice missing config.
      // Tracing is not yet initialized here; buffer the message for later emission.
      push_startup_warning("[config] RUN_MODE not set, defaulting to 'development'");
    }
    let base_path = sources.base_path;
    let source_snapshot = sources.source_snapshot;
    let s = sources.config;
    // config's integer deserializer truncates floats. Validate these source
    // values first; ENV supplies decimal strings, YAML supplies JSON numbers.
    for path in [
      "websocket.eio_ping_interval_seconds",
      "websocket.eio_ping_timeout_seconds",
    ] {
      match s.get::<serde_json::Value>(path) {
        Ok(value) => {
          let seconds = value.as_u64().or_else(|| {
            value
              .as_str()
              .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
              .and_then(|value| value.parse::<u64>().ok())
          });
          if seconds.is_none_or(|seconds| seconds == 0) {
            return Err(ConfigError::Message(format!(
              "{path} must be positive integral seconds"
            )));
          }
        }
        Err(ConfigError::NotFound(_)) => {} // The typed field default still applies.
        Err(error) => return Err(error),
      }
    }
    if startup_effects {
      warn_deprecated_telemetry_keys(&s);
      warn_deprecated_database_config_keys(&s);
    }
    if startup_effects && s.get::<serde_json::Value>("copilot.transcription_model").is_ok() {
      push_startup_warning(
        "[config] copilot.transcription_model is deprecated; use transcription.model. This alias does not enable transcription or select a speech endpoint.",
      );
    }
    for descriptor in CONFIG_REGISTRY.iter().filter(|field| {
      field.path.starts_with("transcription.")
        && field.value_type == myoxus_contracts::effective_config::ConfigValueType::Number
    }) {
      if let Ok(value) = s.get::<serde_json::Value>(descriptor.path) {
        let integer = value
          .as_u64()
          .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()));
        if integer.is_none() {
          return Err(ConfigError::Message(format!(
            "{} must be a positive integer",
            descriptor.path
          )));
        }
      }
    }
    let mut cfg: Self = s.try_deserialize()?;
    cfg.source_snapshot = source_snapshot;
    cfg.apply_storage_mb_bytes_migration();
    cfg.load_compat_feature_files(&base_path)?;
    cfg.validate_transcription_config()?;
    cfg.validate_doc_service_endpoint()?;
    cfg.validate_tuning_parameters()?;
    if !(64 * 1024..=64 * 1024 * 1024).contains(&cfg.mcp.document_export_max_bytes) {
      return Err(ConfigError::Message(
        "mcp.documentExportMaxBytes must be between 65536 and 67108864".to_string(),
      ));
    }
    let generated_captcha_key = if startup_effects {
      cfg.bootstrap_captcha_hmac_key()
    } else if cfg.captcha.enabled && cfg.captcha.hmac_key.trim().is_empty() {
      // Real startup materializes a random key before validation. Candidate
      // validation uses a process-local placeholder to exercise the identical
      // typed contract without writing a mirror or consuming randomness.
      cfg.captcha.hmac_key = "candidate-validation-placeholder".to_string();
      false
    } else {
      false
    };
    cfg.validate_captcha_config()?;
    cfg.validate_complete_candidate()?;
    if generated_captcha_key {
      // Publication follows validation of the complete typed configuration.
      // This startup-owned safety net therefore cannot make an overlay visible
      // before the candidate that contains it has passed the startup contract.
      cfg.persist_generated_captcha_hmac_key();
    }
    if startup_effects {
      cfg.warn_default_crypto_key();
    }
    Ok(cfg)
  }

  /// Applies validated database rows at their exact serde paths and rebuilds
  /// the typed startup configuration. Infrastructure connection settings have
  /// already been consumed before this point; every subsequently constructed
  /// service receives this single final snapshot.
  pub fn with_database_overrides(self, overrides: &HashMap<String, serde_json::Value>) -> Result<Self, ConfigError> {
    let source_snapshot = self.source_snapshot.clone();
    let additional_ca = self.additional_ca.clone();
    // The webhook secret is deliberately excluded from every serialized
    // configuration projection. Preserve the trusted YAML/ENV value while
    // rebuilding the public, database-overridable portion of the snapshot.
    let git_sync_webhook_secret = self.git_sync.webhook_secret.clone();
    let mut value = serde_json::to_value(&self)
      .map_err(|error| ConfigError::Message(format!("failed to project typed configuration: {error}")))?;
    for (path, override_value) in overrides {
      if path == "tls.additional_ca_bundle_path" {
        return Err(ConfigError::Message(
          "tls.additional_ca_bundle_path cannot be authored by a database override".to_string(),
        ));
      }
      set_serialized_config_path(&mut value, path, override_value.clone())?;
    }
    let mut config: Self = serde_json::from_value(value)
      .map_err(|error| ConfigError::Message(format!("invalid database configuration override: {error}")))?;
    config.source_snapshot = source_snapshot;
    config.additional_ca = additional_ca;
    config.git_sync.webhook_secret = git_sync_webhook_secret;
    config.validate_transcription_config()?;
    config.validate_doc_service_endpoint()?;
    config.validate_tuning_parameters()?;
    config.validate_captcha_config()?;
    config.validate_complete_candidate()?;
    Ok(config)
  }

  /// Validate the shared speech endpoint contract before startup or live publication.
  fn validate_transcription_config(&self) -> Result<(), ConfigError> {
    if !self.transcription.endpoint.is_empty() {
      myoxus_infrastructure::transcription::validate_endpoint(&self.transcription.endpoint)
        .map_err(|message| ConfigError::Message(format!("transcription.endpoint: {message}")))?;
    }
    if self.transcription.model.len() > 256 || self.transcription.model.chars().any(char::is_control) {
      return Err(ConfigError::Message(
        "transcription.model must be at most 256 characters without control characters".into(),
      ));
    }
    if self
      .transcription
      .language
      .as_ref()
      .is_some_and(|value| value.len() > 64 || value.chars().any(char::is_control))
    {
      return Err(ConfigError::Message(
        "transcription.language must be at most 64 characters without control characters".into(),
      ));
    }
    if self
      .transcription
      .api_key
      .as_ref()
      .is_some_and(|value| value.len() > 16_384 || value.chars().any(char::is_control))
    {
      return Err(ConfigError::Message(
        "transcription.api_key must be a valid protected header value".into(),
      ));
    }
    Ok(())
  }

  /// Validates invariants that span multiple registry paths against the final
  /// typed snapshot. This runs both before infrastructure startup and after
  /// database overrides are projected, so out-of-band rows cannot bypass the
  /// same candidate contract enforced by public writers.
  fn validate_complete_candidate(&self) -> Result<(), ConfigError> {
    let serialized = serde_json::to_value(self)
      .map_err(|error| ConfigError::Message(format!("failed to validate typed configuration: {error}")))?;
    let values = CONFIG_REGISTRY
      .iter()
      .filter_map(|descriptor| {
        serialized_config_value_at_path(&serialized, descriptor.path)
          .cloned()
          .map(|value| (descriptor.path.to_string(), value))
      })
      .collect::<BTreeMap<_, _>>();
    validate_config_candidate(&values).map_err(ConfigError::Message)
  }

  /// P-Captcha-A2 / INV-CAPTCHA-08: Safety-net — if captcha is enabled but no
  /// `hmac_key` was provided, generate a cryptographically-strong 32-byte key
  /// (hex-encoded). The caller validates the complete candidate before invoking
  /// the separate persistence step, so the safety net never publishes a key as
  /// part of an otherwise invalid startup overlay.
  fn bootstrap_captcha_hmac_key(&mut self) -> bool {
    if !self.captcha.enabled || !self.captcha.hmac_key.trim().is_empty() {
      return false;
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let key = hex::encode(bytes);
    self.captcha.hmac_key = key;
    true
  }

  /// Mirror a generated key only after the complete startup candidate passed.
  /// When writeback is disabled or fails, startup keeps the validated in-memory
  /// key and reports the operator-visible durability warning below.
  fn persist_generated_captcha_hmac_key(&self) {
    let writeback = myoxus_infrastructure::app_config::try_writeback(&[(
      "captcha.hmac_key".to_string(),
      serde_json::Value::String(self.captcha.hmac_key.clone()),
    )]);
    match writeback {
      myoxus_infrastructure::app_config::WritebackOutcome::Written => push_startup_warning(
        "[captcha] no hmac_key configured — generated a fresh 32-byte key and \
         persisted it to the configured runtime overlay",
      ),
      myoxus_infrastructure::app_config::WritebackOutcome::Unchanged => {}
      myoxus_infrastructure::app_config::WritebackOutcome::Disabled => push_startup_warning(
        "[captcha] no hmac_key configured — generated a fresh 32-byte key \
         in memory only (runtime config writeback is disabled). Set captcha.hmac_key in \
         config or via MYOXUS__CAPTCHA__HMAC_KEY to avoid regenerating on \
         every restart (would invalidate outstanding challenges)",
      ),
      myoxus_infrastructure::app_config::WritebackOutcome::Failed => push_startup_warning(
        "[captcha] CONFIG_WRITEBACK_FAILED — generated a fresh 32-byte key in \
         memory, but the configured runtime overlay could not be updated",
      ),
    }
  }

  /// INV-CAPTCHA-01: `captcha.hmac_key` is mandatory when `captcha.enabled = true`.
  /// INV-CAPTCHA-07 (algo-whitelist): `captcha.algorithm` must be one of the
  /// supported PoW algorithms.
  fn validate_captcha_config(&self) -> Result<(), ConfigError> {
    if !self.captcha.enabled {
      return Ok(());
    }
    if self.captcha.hmac_key.trim().is_empty() {
      return Err(ConfigError::Message(
        "captcha.enabled = true but captcha.hmac_key is empty — set MYOXUS__CAPTCHA__HMAC_KEY \
         (generate via `openssl rand -hex 32`) or disable captcha"
          .to_string(),
      ));
    }
    const ALLOWED_ALGOS: &[&str] = &["SHA-256", "SHA-384", "SHA-512"];
    if !ALLOWED_ALGOS.contains(&self.captcha.algorithm.as_str()) {
      return Err(ConfigError::Message(format!(
        "captcha.algorithm = {:?} is invalid; expected one of {:?}",
        self.captcha.algorithm, ALLOWED_ALGOS
      )));
    }
    if self.captcha.challenge_expires_seconds == 0 {
      return Err(ConfigError::Message(
        "captcha.challenge_expires_seconds must be > 0".to_string(),
      ));
    }
    if self.captcha.max_number == 0 {
      return Err(ConfigError::Message("captcha.max_number must be > 0".to_string()));
    }
    if self.captcha.honeypot_field_name.trim().is_empty() {
      return Err(ConfigError::Message(
        "captcha.honeypot_field_name must not be empty".to_string(),
      ));
    }
    Ok(())
  }

  pub fn bind_addr(&self) -> SocketAddr {
    format!("{}:{}", self.server.host, self.server.port)
      .parse()
      .expect("Invalid bind address")
  }

  fn load_compat_feature_files(&mut self, base_path: &Path) -> Result<(), ConfigError> {
    let user_features = load_features_file(
      base_path,
      &self.compat.features.user_file,
      self.compat.features.user.clone(),
    )?;
    let workspace_features = load_features_file(
      base_path,
      &self.compat.features.workspace_file,
      self.compat.features.workspace.clone(),
    )?;
    self.compat.features.user = user_features;
    self.compat.features.workspace = workspace_features;
    strip_unsupported_static_features(&mut self.compat.features.user);
    strip_unsupported_static_features(&mut self.compat.features.workspace);
    Ok(())
  }

  /// API-RV-09c: Validate `doc_service.endpoint` at startup.
  fn validate_doc_service_endpoint(&self) -> Result<(), ConfigError> {
    validate_doc_service_endpoint(self.doc_service.endpoint.as_deref())
  }

  /// P34-B-03: Validate tuning parameters at startup.
  ///
  /// - Zero timeouts are always fatal (ERROR + reject).
  /// - Values below recommended minimums produce WARN but are accepted.
  fn validate_tuning_parameters(&self) -> Result<(), ConfigError> {
    validate_tuning_parameters(self)
  }

  /// SC-C-03: Warn loudly if the default crypto key is still in use.
  ///
  /// Does NOT refuse to start (would break dev setups) — just emits a WARN.
  fn warn_default_crypto_key(&self) {
    if self.crypto.private_key == "myoxus-change-me-private-key" {
      tracing::warn!("SECURITY: Using default crypto key. Set a unique key in config before production deployment.");
    }
  }

  /// P91-CFG-E-R02: Log storage config MB/Bytes migration status.
  ///
  /// Detect and auto-convert legacy byte-based config values to MB.
  ///
  /// With `#[serde(alias = "…")]` on the MB fields, old YAML keys like
  /// `maxUploadBytes: 536870912` deserialize directly into `max_upload_mb`
  /// — but with the raw byte value.  This method applies a heuristic:
  /// Detect and fix MB fields that actually contain byte values due to serde
  /// aliases (e.g. `maxUploadBytes` → `max_upload_mb`).
  ///
  /// **How it works:**
  /// 1. Serde aliases like `maxUploadBytes` deserialize the raw bytes value
  ///    directly into the `_mb` field (e.g. `max_upload_mb = 10_485_760`).
  /// 2. This method detects suspiciously large values (> 1024) and
  ///    auto-converts them by dividing by 1 048 576 (1 MiB).
  /// 3. Edge cases: values 1025–1 048 575 are ambiguous but treated as bytes
  ///    because no sane MB-based setting would exceed 1 TB.
  /// 4. The minimum output is always 1 MB (never 0) to prevent silent
  ///    zero-configs from integer division truncation.
  ///
  /// Also covers `websocket.max_http_buffer_size_mb` (alias `maxHttpBufferSize`).
  ///
  /// The database side of the Bytes→MB migration is handled separately by
  /// canonical byte-based configuration schema.
  fn apply_storage_mb_bytes_migration(&mut self) {
    const BYTES_TO_MB: u64 = 1_048_576;
    // Values above this threshold are almost certainly bytes, not MB.
    // 1024 MB = 1 GB — a reasonable upper bound for any MB-based setting.
    const THRESHOLD: u64 = 1024;

    // ── StorageConfig fields ──────────────────────────────────────────
    if self.storage.max_upload_mb > THRESHOLD {
      let old = self.storage.max_upload_mb;
      self.storage.max_upload_mb = (old / BYTES_TO_MB).max(1);
      tracing::warn!(
        key = "storage.maxUploadMb",
        old_value = %old,
        new_mb = %self.storage.max_upload_mb,
        "Value looks like bytes, auto-converting to MB. Please update your YAML to use MB-based keys."
      );
    }

    if self.storage.multipart_threshold_mb > THRESHOLD {
      let old = self.storage.multipart_threshold_mb;
      self.storage.multipart_threshold_mb = (old / BYTES_TO_MB).max(1);
      tracing::warn!(
        key = "storage.multipartThresholdMb",
        old_value = %old,
        new_mb = %self.storage.multipart_threshold_mb,
        "Value looks like bytes, auto-converting to MB. Please update your YAML to use MB-based keys."
      );
    }

    if self.storage.min_free_space_mb > THRESHOLD {
      let old = self.storage.min_free_space_mb;
      self.storage.min_free_space_mb = (old / BYTES_TO_MB).max(1);
      tracing::warn!(
        key = "storage.minFreeSpaceMb",
        old_value = %old,
        new_mb = %self.storage.min_free_space_mb,
        "Value looks like bytes, auto-converting to MB. Please update your YAML to use MB-based keys."
      );
    }

    // ── WebSocketConfig field ─────────────────────────────────────────
    if self.websocket.max_http_buffer_size_mb > THRESHOLD {
      let old = self.websocket.max_http_buffer_size_mb;
      self.websocket.max_http_buffer_size_mb = (old / BYTES_TO_MB).max(1);
      tracing::warn!(
        key = "websocket.maxHttpBufferSizeMb",
        old_value = %old,
        new_mb = %self.websocket.max_http_buffer_size_mb,
        "Value looks like bytes, auto-converting to MB. Please update your YAML to use MB-based keys."
      );
    }

    // ── BrandingConfig field ──────────────────────────────────────────
    if self.branding.max_upload_mb > THRESHOLD {
      let old = self.branding.max_upload_mb;
      self.branding.max_upload_mb = (old / BYTES_TO_MB).max(1);
      tracing::warn!(
        key = "branding.maxUploadMb",
        old_value = %old,
        new_mb = %self.branding.max_upload_mb,
        "Value looks like bytes, auto-converting to MB. Please update your YAML to use MB-based key `max_upload_mb`."
      );
    }

    tracing::info!("[config] Storage MB/Bytes migration check complete (P91-CFG-G)");
  }
}

/// API-owned implementation of the narrow startup-validation port used by all
/// configuration writers. The startup schema remains in this module; lower
/// layers receive only success or a sanitized diagnostic.
#[derive(Clone, Copy, Debug, Default)]
pub struct AppConfigStartupValidator;

impl myoxus_application::config_validation::StartupConfigValidator for AppConfigStartupValidator {
  fn validate(&self, candidate: &myoxus_application::config_validation::PreparedConfigCandidate) -> Result<(), String> {
    let sanitize = |error: ConfigError| sanitize_candidate_validation_error(error, candidate);
    let sources =
      load_server_config_sources_for_candidate(candidate.runtime_overlay_yaml.as_deref()).map_err(&sanitize)?;
    let config = AppConfig::from_loaded_sources(sources, false).map_err(&sanitize)?;
    config
      .with_database_overrides(&candidate.database_overrides)
      .map(|_| ())
      .map_err(sanitize)
  }
}

fn sanitize_candidate_validation_error(
  error: ConfigError,
  candidate: &myoxus_application::config_validation::PreparedConfigCandidate,
) -> String {
  fn collect_strings(value: &serde_json::Value, strings: &mut Vec<String>) {
    match value {
      serde_json::Value::String(value) if !value.is_empty() => strings.push(value.clone()),
      serde_json::Value::Array(values) => values.iter().for_each(|value| collect_strings(value, strings)),
      serde_json::Value::Object(values) => values.values().for_each(|value| collect_strings(value, strings)),
      _ => {}
    }
  }

  let mut message = error.to_string();
  let mut supplied_strings = Vec::new();
  candidate
    .database_overrides
    .values()
    .for_each(|value| collect_strings(value, &mut supplied_strings));
  if let Some(overlay) = candidate.runtime_overlay_yaml.as_deref()
    && let Ok(value) = decode_config_document(overlay, ConfigDocumentFormat::Yaml)
  {
    collect_strings(&value, &mut supplied_strings);
  }
  supplied_strings.sort_by_key(|value| std::cmp::Reverse(value.len()));
  supplied_strings.dedup();
  for value in supplied_strings {
    message = message.replace(&value, "[redacted]");
  }
  redact_double_quoted_values(&message)
}

fn redact_double_quoted_values(message: &str) -> String {
  let mut redacted = String::with_capacity(message.len());
  let mut quoted = false;
  for character in message.chars() {
    if character == '"' {
      if quoted {
        redacted.push_str("[redacted]\"");
      } else {
        redacted.push('"');
      }
      quoted = !quoted;
    } else if !quoted {
      redacted.push(character);
    }
  }
  if quoted {
    redacted.push_str("[redacted]");
  }
  redacted
}

fn set_serialized_config_path(
  root: &mut serde_json::Value,
  path: &str,
  value: serde_json::Value,
) -> Result<(), ConfigError> {
  let mut segments = path.split('.').peekable();
  let mut current = root;
  while let Some(segment) = segments.next() {
    if segments.peek().is_none() {
      let object = current
        .as_object_mut()
        .ok_or_else(|| ConfigError::Message(format!("configuration parent for `{path}` is not an object")))?;
      // Registered map entries such as `oauth.providers.oidc` may be absent
      // from the file baseline. The final typed deserialization below remains
      // authoritative and rejects a value that does not match the map value.
      object.insert(segment.to_string(), value);
      return Ok(());
    }
    current = current.get_mut(segment).ok_or_else(|| {
      ConfigError::Message(format!(
        "configuration descriptor `{path}` has no typed AppConfig field"
      ))
    })?;
  }
  Err(ConfigError::Message("configuration path must not be empty".to_string()))
}

fn serialized_config_value_at_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
  path.split('.').try_fold(root, |value, segment| value.get(segment))
}

/// API-RV-09c: Validate a `doc_service.endpoint` value at startup to prevent
/// SSRF and accidental credential leakage via cookie forwarding.
///
/// Rules:
/// 1. `None` or empty/whitespace → OK (local mode, no proxy).
/// 2. HTTPS endpoints → allowed.
/// 3. Plain HTTP → only `localhost` / `127.0.0.1` (dev use).
/// 4. Cloud metadata endpoints (169.254.169.254, metadata.google.internal,
///    etc.) → always rejected regardless of scheme.
fn validate_doc_service_endpoint(endpoint: Option<&str>) -> Result<(), ConfigError> {
  let endpoint = match endpoint {
    Some(ep) if !ep.trim().is_empty() => ep.trim(),
    _ => return Ok(()),
  };

  // Block cloud metadata / link-local destinations (SSRF targets).
  const BLOCKED_HOSTS: &[&str] = &[
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.goog",
    "100.100.100.200", // Alibaba Cloud metadata
  ];
  let lower = endpoint.to_ascii_lowercase();
  for blocked in BLOCKED_HOSTS {
    if lower.contains(blocked) {
      return Err(ConfigError::Message(format!(
        "doc_service.endpoint points to blocked metadata service ({blocked}): \
         this is a security risk (SSRF). Remove or change the endpoint."
      )));
    }
  }

  // Scheme validation
  let is_https = lower.starts_with("https://");
  let is_localhost_http = lower.starts_with("http://localhost") || lower.starts_with("http://127.0.0.1");

  if !is_https && !is_localhost_http {
    return Err(ConfigError::Message(format!(
      "doc_service.endpoint must use HTTPS (or http://localhost for dev). \
       Got: {endpoint}"
    )));
  }

  tracing::info!(endpoint, "doc_service.endpoint validated (API-RV-09c)");
  Ok(())
}

/// P34-B-03: Validate tuning parameters at startup.
///
/// Fatal (ERROR + reject config): zero timeouts, broadcast capacity below 16.
/// Warning: values below recommended minimums (accepted but logged).
fn validate_tuning_parameters(cfg: &AppConfig) -> Result<(), ConfigError> {
  // ── Fatal: truly invalid values ───────────────────────────────────────

  validate_doc_ingress_config(&cfg.doc.ingress)?;

  resolve_password_reset_ttl_seconds(cfg, &HashMap::new())?;

  if cfg.websocket.broadcast_channel_capacity < 16 {
    return Err(ConfigError::Message(format!(
      "websocket.broadcast_channel_capacity must be >= 16, got {}",
      cfg.websocket.broadcast_channel_capacity
    )));
  }

  if !(1..=100).contains(&cfg.websocket.max_connections_per_second_per_client) {
    return Err(ConfigError::Message(format!(
      "websocket.max_connections_per_second_per_client must be between 1 and 100, got {}",
      cfg.websocket.max_connections_per_second_per_client
    )));
  }

  if cfg.storage.io_timeout_seconds == 0 {
    return Err(ConfigError::Message(
      "storage.io_timeout_seconds must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if cfg.http.proxy_timeout_seconds == 0 {
    return Err(ConfigError::Message(
      "http.proxy_timeout_seconds must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if cfg.worker.polling.doc_maintenance_interval_ms < 5000 {
    return Err(ConfigError::Message(format!(
      "worker.polling.doc_maintenance_interval_ms must be >= 5000 (5s minimum), got {}",
      cfg.worker.polling.doc_maintenance_interval_ms
    )));
  }

  if cfg.worker.polling.indexer_auto_index_interval_ms < 5000 {
    return Err(ConfigError::Message(format!(
      "worker.polling.indexer_auto_index_interval_ms must be >= 5000 (5s minimum), got {}",
      cfg.worker.polling.indexer_auto_index_interval_ms
    )));
  }

  if cfg.worker.polling.document_graph_reindex_interval_ms < 5000 {
    return Err(ConfigError::Message(format!(
      "worker.polling.document_graph_reindex_interval_ms must be >= 5000 (5s minimum), got {}",
      cfg.worker.polling.document_graph_reindex_interval_ms
    )));
  }

  if cfg.worker.polling.database_projection_interval_ms < 5000 {
    return Err(ConfigError::Message(format!(
      "worker.polling.database_projection_interval_ms must be >= 5000 (5s minimum), got {}",
      cfg.worker.polling.database_projection_interval_ms
    )));
  }

  if !(1_000..=3_600_000).contains(&cfg.worker.polling.database_reminder_interval_ms) {
    return Err(ConfigError::Message(format!(
      "worker.polling.database_reminder_interval_ms must be between 1000 and 3600000, got {}",
      cfg.worker.polling.database_reminder_interval_ms
    )));
  }

  if !(1..=1_000).contains(&cfg.databases.reminder_batch_size) {
    return Err(ConfigError::Message(format!(
      "databases.reminder_batch_size must be between 1 and 1000, got {}",
      cfg.databases.reminder_batch_size
    )));
  }
  if !(1..=20).contains(&cfg.databases.max_reminders_per_user_per_cell) {
    return Err(ConfigError::Message(format!(
      "databases.max_reminders_per_user_per_cell must be between 1 and 20, got {}",
      cfg.databases.max_reminders_per_user_per_cell
    )));
  }
  if !(0..=5_256_000).contains(&cfg.databases.max_reminder_offset_minutes) {
    return Err(ConfigError::Message(format!(
      "databases.max_reminder_offset_minutes must be between 0 and 5256000, got {}",
      cfg.databases.max_reminder_offset_minutes
    )));
  }

  let workspace_import = cfg.workspace.r#import;
  if workspace_import.max_upload_bytes == 0
    || workspace_import.max_expanded_bytes == 0
    || workspace_import.max_archive_entries == 0
    || workspace_import.max_entry_bytes == 0
    || workspace_import.max_compression_ratio == 0
    || workspace_import.max_sqlite_bytes == 0
    || workspace_import.max_documents == 0
    || workspace_import.max_blocks == 0
    || workspace_import.max_databases == 0
    || workspace_import.max_rows_per_database == 0
    || workspace_import.max_cells_per_database == 0
    || workspace_import.max_assets == 0
    || workspace_import.max_asset_bytes == 0
    || workspace_import.staging_retention_hours == 0
    || workspace_import.job_timeout_seconds == 0
    || workspace_import.worker_concurrency == 0
  {
    return Err(ConfigError::Message(
      "workspace.import limits, retention, timeout and worker concurrency must be positive".to_string(),
    ));
  }
  if workspace_import.max_entry_bytes > workspace_import.max_expanded_bytes {
    return Err(ConfigError::Message(
      "workspace.import.max_entry_bytes must not exceed max_expanded_bytes".to_string(),
    ));
  }
  if workspace_import.max_sqlite_bytes > workspace_import.max_upload_bytes {
    return Err(ConfigError::Message(
      "workspace.import.max_sqlite_bytes must not exceed max_upload_bytes".to_string(),
    ));
  }
  if workspace_import.max_asset_bytes > workspace_import.max_expanded_bytes {
    return Err(ConfigError::Message(
      "workspace.import.max_asset_bytes must not exceed max_expanded_bytes".to_string(),
    ));
  }

  if cfg.worker.polling.calendar_reminder_interval_ms < 5000 {
    return Err(ConfigError::Message(format!(
      "worker.polling.calendar_reminder_interval_ms must be >= 5000 (5s minimum), got {}",
      cfg.worker.polling.calendar_reminder_interval_ms
    )));
  }

  if cfg.document_graph.max_graph_nodes == 0
    || cfg.document_graph.max_graph_edges == 0
    || cfg.document_graph.max_occurrences_per_edge == 0
    || cfg.document_graph.max_reindex_batch <= 0
    || cfg.document_graph.max_catch_up_workspaces <= 0
    || cfg.document_graph.preview_max_chars == 0
    || cfg.document_graph.stale_after_seconds <= 0
    || cfg.document_graph.enqueue_delay_ms < 0
    || cfg.document_graph.max_reindex_attempts <= 0
  {
    return Err(ConfigError::Message(
      "document_graph limits must be positive and enqueue_delay_ms must be >= 0".to_string(),
    ));
  }

  if cfg.workspace_automation.max_actions_per_run == 0
    || cfg.workspace_automation.max_runs_per_minute <= 0
    || cfg.workspace_automation.webhook_timeout_seconds == 0
    || cfg.workspace_automation.max_retry_attempts <= 0
  {
    return Err(ConfigError::Message(
      "workspace_automation limits must be positive".to_string(),
    ));
  }

  // ── P36-A: Git sync config validation ────────────────────────────────

  if !(1..=30).contains(&cfg.git_sync.retention_days) {
    return Err(ConfigError::Message(
      "git_sync.retention_days must be an integer in 1..=30".into(),
    ));
  }

  if cfg.git_sync.network_timeout_secs == 0 {
    return Err(ConfigError::Message(
      "git_sync.network_timeout_secs must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if cfg.git_sync.local_timeout_secs == 0 {
    return Err(ConfigError::Message(
      "git_sync.local_timeout_secs must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if cfg.git_sync.clone_depth == 0 {
    return Err(ConfigError::Message(
      "git_sync.clone_depth must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if cfg.git_sync.commit_author_name.trim().is_empty() {
    return Err(ConfigError::Message(
      "git_sync.commit_author_name must not be empty".to_string(),
    ));
  }

  if cfg.git_sync.commit_author_email.trim().is_empty() {
    return Err(ConfigError::Message(
      "git_sync.commit_author_email must not be empty".to_string(),
    ));
  }

  if cfg.git_sync.parallel_conversion_threshold == 0 {
    return Err(ConfigError::Message(
      "git_sync.parallel_conversion_threshold must be >= 1 (cannot be zero)".to_string(),
    ));
  }

  if !matches!(cfg.git_sync.mime_validation_mode.as_str(), "strict" | "warn") {
    return Err(ConfigError::Message(format!(
      "git_sync.mime_validation_mode must be \"strict\" or \"warn\", got \"{}\"",
      cfg.git_sync.mime_validation_mode
    )));
  }

  if cfg.git_sync.https_certificate_policy == HttpsCertificatePolicy::InsecureNoVerify
    && cfg.git_sync.allowed_hosts.iter().all(|host| host.trim().is_empty())
  {
    return Err(ConfigError::Message(
      "git_sync.https_certificate_policy = \"insecure_no_verify\" requires at least one explicit git_sync.allowed_hosts entry"
        .to_string(),
    ));
  }

  if let Some(path) = cfg.git_sync.https_ca_bundle_path.as_deref() {
    validate_git_sync_ca_bundle_relative_path(path).map_err(ConfigError::Message)?;
  }
  if let Some(path) = cfg.tls.additional_ca_bundle_path.as_deref() {
    myoxus_infrastructure::tls::validate_relative_path(path).map_err(ConfigError::Message)?;
  }

  if cfg.git_sync.webhook_allowed
    && cfg
      .git_sync
      .webhook_secret
      .as_deref()
      .is_none_or(|secret| secret.trim().is_empty())
  {
    return Err(ConfigError::Message(
      "git_sync.webhook_allowed = true requires git_sync.webhook_secret to be set via YAML/ENV".to_string(),
    ));
  }

  // ROB-26: lock TTL must be a sane positive value AND must cover the
  // maximum-conceivable sync wall-clock. Reject zero (instant expiry =
  // no lock) and warn on values smaller than `network_timeout_secs`
  // (the lock would expire while a single fetch/push call is still
  // in-flight). Hard-cap at one hour because anything longer is
  // almost certainly a misconfiguration — long-running syncs should
  // be solved by a heartbeat refresh, not by an extreme TTL.
  if cfg.git_sync.lock_ttl_seconds == 0 {
    return Err(ConfigError::Message(
      "git_sync.lock_ttl_seconds must be >= 1 (cannot be zero — lock would expire instantly)".to_string(),
    ));
  }
  if cfg.git_sync.lock_ttl_seconds > 3600 {
    return Err(ConfigError::Message(format!(
      "git_sync.lock_ttl_seconds = {} exceeds 3600s (1h) — long-running syncs should use \
       a heartbeat refresh instead of an extreme TTL",
      cfg.git_sync.lock_ttl_seconds
    )));
  }

  // ── Warnings: unusual but accepted values ─────────────────────────────

  if cfg.storage.io_timeout_seconds < 5 {
    tracing::warn!(
      io_timeout_seconds = cfg.storage.io_timeout_seconds,
      "storage.io_timeout_seconds is below recommended minimum of 5s — S3 operations may time out under load"
    );
  }

  if cfg.http.proxy_timeout_seconds < 5 {
    tracing::warn!(
      proxy_timeout_seconds = cfg.http.proxy_timeout_seconds,
      "http.proxy_timeout_seconds is below recommended minimum of 5s — proxy requests may time out prematurely"
    );
  }

  if cfg.websocket.broadcast_channel_capacity < 256 {
    tracing::warn!(
      broadcast_channel_capacity = cfg.websocket.broadcast_channel_capacity,
      "websocket.broadcast_channel_capacity is below recommended 256 — may drop messages under burst load"
    );
  }

  tracing::info!("tuning parameters validated (P34-B-03)");
  Ok(())
}

/// Validate the operator-provided CA bundle path without touching the
/// filesystem. The path is always relative to a server-owned config root.
pub fn validate_git_sync_ca_bundle_relative_path(path: &str) -> Result<(), String> {
  myoxus_infrastructure::tls::validate_relative_path(path)
}

pub type MaterializedGitSyncCaBundle = myoxus_infrastructure::tls::ValidatedCaBundle;

/// Load one immutable file/ENV trust snapshot before any network client exists.
pub fn load_global_ca_bundle(config: &AppConfig) -> Result<Option<MaterializedGitSyncCaBundle>, ConfigError> {
  let paths = resolve_server_config_paths();
  let root = paths
    .writeback_path
    .as_deref()
    .and_then(Path::parent)
    .unwrap_or(paths.base_path.as_path());
  myoxus_infrastructure::tls::load_bundle(
    root,
    config.tls.additional_ca_bundle_path.as_deref().unwrap_or_default(),
  )
  .map_err(ConfigError::Message)
}

#[cfg(test)]
fn resolve_git_sync_ca_bundle_below_root(root: &Path, configured: &str) -> Result<PathBuf, ConfigError> {
  myoxus_infrastructure::tls::resolve_below_root(root, configured).map_err(ConfigError::Message)
}

#[cfg(test)]
fn validate_git_sync_ca_bundle(path: &Path) -> Result<usize, ConfigError> {
  myoxus_infrastructure::tls::validate_bundle(path).map_err(ConfigError::Message)
}

/// Materialize the restart-bound Git-Sync CA bundle for libgit2 from the final
/// typed startup configuration. Relative paths are
/// resolved below the directory containing the active writeback YAML; when
/// writeback is disabled, the base config directory is used. Canonicalization
/// also prevents symlink escape from that operator-owned root.
pub fn materialize_git_sync_https_ca_bundle(
  config: &AppConfig,
) -> Result<Option<MaterializedGitSyncCaBundle>, ConfigError> {
  let configured = config
    .git_sync
    .https_ca_bundle_path
    .as_deref()
    .unwrap_or_default()
    .trim();
  if configured.is_empty() {
    return Ok(None);
  }

  let paths = resolve_server_config_paths();
  let root = paths
    .writeback_path
    .as_deref()
    .and_then(Path::parent)
    .unwrap_or(paths.base_path.as_path());
  myoxus_infrastructure::git_sync::ca_bundle::materialize(root, configured).map_err(ConfigError::Message)
}

fn validate_doc_ingress_config(config: &DocIngressConfig) -> Result<(), ConfigError> {
  if config.max_update_bytes().is_none() {
    return Err(ConfigError::Message(format!(
      "doc.ingress.max_update_mb must be greater than zero and fit the host usize, got {}",
      config.max_update_mb
    )));
  }
  Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
struct CompatibilityFeaturesFile {
  #[serde(default)]
  features: Vec<CompatibilityFeature>,
}

fn load_features_file(
  base_path: &Path,
  path_or_name: &str,
  fallback: Vec<CompatibilityFeature>,
) -> Result<Vec<CompatibilityFeature>, ConfigError> {
  if path_or_name.trim().is_empty() {
    let mut fallback = fallback;
    dedup_compat_features(&mut fallback);
    strip_unsupported_static_features(&mut fallback);
    return Ok(fallback);
  }

  let path = if Path::new(path_or_name).is_absolute() {
    PathBuf::from(path_or_name)
  } else {
    base_path.join(path_or_name)
  };

  let file_content = fs::read_to_string(&path).map_err(|e| {
    ConfigError::Message(format!(
      "failed to read compatibility features file {}: {e}",
      path.display()
    ))
  })?;
  let mut parsed: CompatibilityFeaturesFile = decode_typed_yaml_document(&file_content).map_err(|e| {
    ConfigError::Message(format!(
      "failed to parse compatibility features file {}: {e}",
      path.display()
    ))
  })?;

  dedup_compat_features(&mut parsed.features);
  strip_unsupported_static_features(&mut parsed.features);
  Ok(parsed.features)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{
    collections::HashMap,
    fs,
    time::{SystemTime, UNIX_EPOCH},
  };

  #[test]
  fn document_history_startup_normalizes_only_positive_legacy_intervals() {
    let legacy: DocHistoryConfig = decode_typed_yaml_document("interval: 30000\n").expect("legacy interval");
    assert!(legacy.enabled);
    assert_eq!(legacy.interval, 900_000);
    let explicit: DocHistoryConfig = decode_typed_yaml_document("interval: 1800000\n").expect("explicit interval");
    assert_eq!(explicit.interval, 1_800_000);
    assert!(decode_typed_yaml_document::<DocHistoryConfig>("interval: 0\n").is_err());
    assert!(decode_typed_yaml_document::<DocHistoryConfig>("interval: 86400001\n").is_err());
  }

  #[test]
  fn oauth_provider_map_preserves_named_runtime_shapes_and_nested_aliases() {
    let oauth: OAuthConfig = serde_json::from_value(serde_json::json!({
      "providers": {
        "google": { "client_id": "google-id", "client_secret": "google-secret" },
        "oidc": {
          "clientId": "oidc-id",
          "clientSecret": "oidc-secret",
          "authUrl": "https://idp.example/authorize",
          "tokenUrl": "https://idp.example/token",
          "userinfoUrl": "https://idp.example/userinfo",
          "claims": { "email_verified": "EmailVerified" },
          "group_mapping": {
            "unknown_groups": "deny_login",
            "mappings": [{
              "provider_group": "Engineering/Admins",
              "target_unit_id": "00000000-0000-0000-0000-000000000001"
            }]
          }
        }
      }
    }))
    .expect("named provider shapes");

    let google = oauth.custom_provider("GOOGLE").expect("Google provider");
    assert_eq!(google.client_id, "google-id");
    assert!(google.auth_url.is_empty());
    assert_eq!(
      oauth.built_in_provider_credentials("google"),
      Some(("google-id", "google-secret"))
    );
    let oidc = oauth.custom_provider("oidc").expect("OIDC provider");
    assert_eq!(oidc.claims.email_verified.as_deref(), Some("EmailVerified"));
    assert_eq!(oidc.group_mapping.unknown_groups, OAuthUnknownGroupsPolicy::DenyLogin);
    assert_eq!(oidc.group_mapping.mappings[0].provider_group, "Engineering/Admins");
  }

  #[test]
  fn oauth_provider_map_rejects_shape_mismatch_without_echoing_values() {
    let error = serde_json::from_value::<OAuthConfig>(serde_json::json!({
      "providers": {
        "github": { "clientId": ["credential-must-not-leak"], "clientSecret": "secret-must-not-leak" }
      }
    }))
    .unwrap_err()
    .to_string();

    assert!(error.contains("clientId"));
    assert!(!error.contains("credential-must-not-leak"));
    assert!(!error.contains("secret-must-not-leak"));
  }

  #[test]
  fn startup_candidate_validates_overlay_before_database_precedence() {
    let candidate = myoxus_application::config_validation::PreparedConfigCandidate {
      database_overrides: HashMap::from([("server.port".to_string(), serde_json::json!(3001))]),
      runtime_overlay_yaml: Some("server:\n  port: hidden-invalid-value\n".to_string()),
    };
    let error =
      myoxus_application::config_validation::StartupConfigValidator::validate(&AppConfigStartupValidator, &candidate)
        .unwrap_err();

    assert!(error.contains("server.port") || error.contains("port"));
    assert!(!error.contains("hidden-invalid-value"));
  }

  #[test]
  fn startup_snapshot_rejects_incoherent_copilot_reasoning_options() {
    let mut config = AppConfig::load().unwrap();
    config.copilot = CopilotConfig::default();
    let provider = config.copilot.providers.get_mut("openai").unwrap();
    provider.models = vec!["model.v1/path".into()];
    provider.model_options = serde_json::from_value(
      serde_json::json!({"model.v1/path":{"reasoning_control":{"type":"reasoning_effort","on":"high","off":"high"}}}),
    )
    .unwrap();
    assert!(config.validate_complete_candidate().is_err());
  }

  #[test]
  fn client_version_default_preserves_the_yrs_027_rollout_boundary() {
    let config = ClientVersionControlConfig::default();
    assert!(config.enabled);
    assert_eq!(config.required_version, ">=0.41.5");
  }

  #[test]
  fn pdf_font_scale_defaults_match_the_renderer_calibration() {
    let config = PdfExportConfig::default();

    assert_eq!(config.heading_font_scale, DEFAULT_HEADING_FONT_SCALE);
    assert_eq!(config.body_font_scale, DEFAULT_BODY_FONT_SCALE);
  }

  #[test]
  fn doc_ingress_defaults_to_32_mib_and_converts_without_overflow() {
    let config = DocIngressConfig::default();
    assert_eq!(config.max_update_mb, 32);
    assert_eq!(config.max_update_bytes(), Some(32 * 1024 * 1024));
    assert_eq!(DocIngressConfig { max_update_mb: 0 }.max_update_bytes(), None);
    assert_eq!(
      DocIngressConfig {
        max_update_mb: u64::MAX
      }
      .max_update_bytes(),
      None
    );
  }

  #[test]
  fn document_decoder_config_defaults_and_database_overrides_are_validated() {
    assert_eq!(DocConfig::default().decoder_concurrency, 8);
    let environment_value = config::Config::builder()
      .set_override("decoder_concurrency", "16")
      .unwrap()
      .build()
      .unwrap();
    assert_eq!(
      environment_value
        .try_deserialize::<DocConfig>()
        .unwrap()
        .decoder_concurrency,
      16
    );
    for source in [
      "decoder_concurrency: 1.5",
      "decoder_concurrency: -1",
      "decoder_concurrency: 0",
    ] {
      let candidate = config::Config::builder()
        .add_source(config::File::from_str(
          &serde_json::to_string(&decode_config_document(source, ConfigDocumentFormat::Yaml).unwrap()).unwrap(),
          config::FileFormat::Json,
        ))
        .build()
        .unwrap();
      assert!(
        candidate.try_deserialize::<DocConfig>().is_err(),
        "invalid source: {source}"
      );
    }
    assert_eq!(
      serde_json::from_value::<DocConfig>(serde_json::json!({}))
        .unwrap()
        .decoder_concurrency,
      8
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let config: AppConfig = decode_typed_yaml_document(&fs::read_to_string(path).unwrap()).unwrap();
    for value in [serde_json::json!(8), serde_json::json!(16), serde_json::json!(32)] {
      let overridden = config
        .clone()
        .with_database_overrides(&HashMap::from([("doc.decoder_concurrency".to_string(), value.clone())]))
        .expect("positive decoder override");
      assert_eq!(overridden.doc.decoder_concurrency as u64, value.as_u64().unwrap());
    }
    for value in [
      serde_json::json!(0),
      serde_json::json!(-1),
      serde_json::json!(1.5),
      serde_json::json!(u64::MAX),
    ] {
      assert!(
        config
          .clone()
          .with_database_overrides(&HashMap::from([("doc.decoder_concurrency".to_string(), value),]))
          .is_err()
      );
    }
  }

  #[test]
  fn doc_ingress_zero_and_overflow_are_startup_errors() {
    assert!(validate_doc_ingress_config(&DocIngressConfig { max_update_mb: 0 }).is_err());
    assert!(
      validate_doc_ingress_config(&DocIngressConfig {
        max_update_mb: u64::MAX
      })
      .is_err()
    );
  }

  #[test]
  fn bundled_default_yaml_keeps_metrics_and_git_sync_enabled() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(&path)
      .unwrap_or_else(|err| panic!("read bundled default config at {}: {err}", path.display()));

    let cfg: AppConfig = decode_typed_yaml_document(&raw).expect("bundled default.yaml parses as AppConfig");

    assert!(
      cfg.metrics.enabled,
      "server/config/default.yaml must enable metrics for new deployments"
    );
    assert!(
      cfg.git_sync.enabled,
      "server/config/default.yaml must enable git_sync for new deployments"
    );
    assert!(
      cfg.auth.reject_plus_aliases,
      "server/config/default.yaml must reject plus aliases by default for new deployments"
    );
    assert_eq!(
      cfg.cors.allowed_custom_headers,
      CorsConfig::default().allowed_custom_headers,
      "server/config/default.yaml must not drift from the native-client CORS header contract"
    );
  }

  #[test]
  fn every_registered_path_exists_and_has_a_writer_valid_default() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let mut config: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");
    config.mail.fallback_smtp = Some(FallbackSmtpConfig {
      host: "smtp-fallback.example.test".to_string(),
      port: 587,
      name: None,
      username: None,
      password: None,
      transport: myoxus_infrastructure::mail::SmtpTransportMode::Starttls,
      verify_certificate: true,
      sender: "noreply@example.test".to_string(),
    });
    let mut serialized = serde_json::to_value(config).expect("serialize typed AppConfig");
    let simple_oauth_provider = serde_json::json!({
      "client_id": "client",
      "client_secret": "secret"
    });
    let custom_oauth_provider = serde_json::json!({
      "client_id": "client",
      "client_secret": "secret",
      "auth_url": "https://id.example.test/auth",
      "token_url": "https://id.example.test/token",
      "userinfo_url": "https://id.example.test/userinfo"
    });
    for provider in ["github", "google"] {
      serialized["oauth"]["providers"][provider] = simple_oauth_provider.clone();
    }
    for provider in ["apple", "oidc"] {
      serialized["oauth"]["providers"][provider] = custom_oauth_provider.clone();
    }
    serde_json::from_value::<AppConfig>(serialized.clone())
      .expect("dynamic provider samples remain valid typed AppConfig values");

    let mut missing = Vec::new();
    let mut invalid = Vec::new();
    for descriptor in myoxus_contracts::effective_config::CONFIG_REGISTRY {
      let mut value = &serialized;
      let mut found = true;
      for segment in descriptor.path.split('.') {
        let Some(next) = value.get(segment) else {
          missing.push(descriptor.path);
          found = false;
          break;
        };
        value = next;
      }
      if found
        && descriptor.database_writable()
        && let Err(error) = myoxus_infrastructure::app_config::validate_config_value(descriptor.path, value)
      {
        invalid.push(format!("{}: {error}", descriptor.path));
      }
    }
    assert!(
      missing.is_empty(),
      "registered paths are not exact typed AppConfig serde paths:\n{}",
      missing.join("\n")
    );
    assert!(
      invalid.is_empty(),
      "registered database-writable defaults violate the canonical writer contract:\n{}",
      invalid.join("\n")
    );
  }

  #[test]
  fn workspace_import_defaults_and_global_limit_projection_match_the_locked_contract() {
    let config = WorkspaceImportConfig::default();
    assert_eq!(config.max_upload_bytes, 2_147_483_648);
    assert_eq!(config.max_expanded_bytes, 8_589_934_592);
    assert_eq!(config.max_archive_entries, 100_000);
    assert_eq!(config.max_entry_bytes, 2_147_483_648);
    assert_eq!(config.max_compression_ratio, 200);
    assert_eq!(config.max_sqlite_bytes, 2_147_483_648);
    assert_eq!(config.max_documents, 100_000);
    assert_eq!(config.max_blocks, 5_000_000);
    assert_eq!(config.max_databases, 10_000);
    assert_eq!(config.max_rows_per_database, 1_000_000);
    assert_eq!(config.max_cells_per_database, 20_000_000);
    assert_eq!(config.max_assets, 250_000);
    assert_eq!(config.max_asset_bytes, 6_442_450_944);
    assert_eq!(config.staging_retention_hours, 24);
    assert_eq!(config.job_timeout_seconds, 7_200);
    assert_eq!(config.worker_concurrency, 1);

    let storage: StorageConfig =
      decode_typed_yaml_document("backend: local\nmax_upload_mb: 64\n").expect("minimal storage config");
    let websocket: WebSocketConfig =
      decode_typed_yaml_document("max_http_buffer_size_mb: 32\n").expect("minimal WebSocket config");
    let databases = DatabasesConfig {
      max_fields_per_database: 17,
      max_views_per_database: 9,
      ..DatabasesConfig::default()
    };
    let limits = config.decoder_limits(
      storage.max_upload_bytes(),
      websocket.max_http_buffer_size(),
      databases.max_fields_per_database,
      databases.max_views_per_database,
    );
    assert_eq!(limits.max_upload_bytes, 64 * 1_048_576);
    assert_eq!(limits.max_entry_bytes, limits.max_upload_bytes);
    assert_eq!(limits.max_sqlite_bytes, limits.max_upload_bytes);
    assert_eq!(limits.max_document_bytes, 32 * 1_048_576);
    assert_eq!(limits.max_asset_bytes, config.max_asset_bytes);
    assert_eq!(limits.max_fields_per_database, 17);
    assert_eq!(limits.max_views_per_database, 9);
  }

  #[test]
  fn workspace_import_config_rejects_zero_and_crossed_resource_limits() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let mut cfg: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");

    cfg.workspace.r#import.max_documents = 0;
    assert!(validate_tuning_parameters(&cfg).is_err());
    cfg.workspace.r#import = WorkspaceImportConfig::default();
    cfg.workspace.r#import.max_entry_bytes = cfg.workspace.r#import.max_expanded_bytes + 1;
    assert!(validate_tuning_parameters(&cfg).is_err());
    cfg.workspace.r#import = WorkspaceImportConfig::default();
    cfg.workspace.r#import.max_sqlite_bytes = cfg.workspace.r#import.max_upload_bytes + 1;
    assert!(validate_tuning_parameters(&cfg).is_err());
    cfg.workspace.r#import = WorkspaceImportConfig::default();
    cfg.workspace.r#import.max_asset_bytes = cfg.workspace.r#import.max_expanded_bytes + 1;
    assert!(validate_tuning_parameters(&cfg).is_err());
  }

  #[test]
  fn auth_config_rejects_plus_aliases_by_default_and_allows_yaml_override() {
    let raw_without_auth = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis: { url: "redis://localhost:6379", namespace: "myoxus" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;

    let default_cfg: AppConfig = decode_typed_yaml_document(raw_without_auth).expect("config without auth parses");
    assert!(
      default_cfg.auth.reject_plus_aliases,
      "missing auth.reject_plus_aliases must use the typed secure default"
    );
    assert_eq!(
      default_cfg.auth.password_reset_ttl_seconds,
      myoxus_application::auth::DEFAULT_PASSWORD_RESET_TTL_SECONDS
    );

    let raw_with_override =
      format!("{raw_without_auth}\nauth:\n  reject_plus_aliases: false\n  password_reset_ttl_seconds: 900\n");
    let override_cfg: AppConfig =
      decode_typed_yaml_document(&raw_with_override).expect("config with auth override parses");
    assert!(
      !override_cfg.auth.reject_plus_aliases,
      "explicit auth.reject_plus_aliases: false must remain a valid admin/operator override"
    );
    assert_eq!(override_cfg.auth.password_reset_ttl_seconds, 900);
  }

  #[test]
  fn password_reset_ttl_resolves_restart_bound_database_override_with_strict_bounds() {
    let config = AppConfig::load().expect("test config");
    let mut overrides = HashMap::new();
    overrides.insert("auth.password_reset_ttl_seconds".to_string(), serde_json::json!(600));
    assert_eq!(
      resolve_password_reset_ttl_seconds(&config, &overrides).expect("valid override"),
      600
    );

    overrides.insert("auth.password_reset_ttl_seconds".to_string(), serde_json::json!(299));
    assert!(resolve_password_reset_ttl_seconds(&config, &overrides).is_err());
    overrides.insert("auth.password_reset_ttl_seconds".to_string(), serde_json::json!("1800"));
    assert!(resolve_password_reset_ttl_seconds(&config, &overrides).is_err());
  }

  #[test]
  fn copilot_config_defaults_when_missing() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis: { url: "redis://localhost:6379", namespace: "myoxus" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.copilot.default_provider, "openai");
    assert!(cfg.copilot.providers.contains_key("openai"));
    assert!(cfg.copilot.providers.contains_key("local"));
    assert_eq!(cfg.copilot.request_timeout_ms, 30_000);
  }

  #[test]
  fn copilot_config_parses_provider_overrides() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis: { url: "redis://localhost:6379", namespace: "myoxus" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
copilot:
  default_provider: "custom"
  fallback_providers: ["openai"]
  request_timeout_ms: 45000
  providers:
    custom:
      enabled: true
      kind: custom
      endpoint: "https://llm.example/v1"
      api_key: "env:COPILOT_CUSTOM_API_KEY"
      models: ["my-model-1"]
      timeout_ms: 120000
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.copilot.default_provider, "custom");
    assert_eq!(cfg.copilot.fallback_providers, vec!["openai".to_string()]);
    assert_eq!(cfg.copilot.request_timeout_ms, 45_000);
    let custom = cfg.copilot.providers.get("custom").expect("custom provider");
    assert!(custom.enabled);
    assert_eq!(custom.kind, CopilotProviderKind::Custom);
    assert_eq!(custom.timeout_ms, 120_000);
  }

  #[test]
  fn redis_config_defaults_when_missing() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert!(cfg.redis.url.is_none());
    assert_eq!(cfg.redis.namespace, "myoxus");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Cache), "myoxus:cache");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Session), "myoxus:session");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Queue), "myoxus:queue");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Socket), "myoxus:socket");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Lock), "myoxus:lock");
    assert!(cfg.redis.session_cache.enabled);
    assert_eq!(cfg.redis.session_cache.ttl_seconds, 300);
    assert!(!cfg.redis.has_url());
  }

  #[test]
  fn redis_session_cache_parses_override() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis:
  url: "redis://localhost:6379"
  namespace: "myoxus"
  session_cache:
    enabled: false
    ttl_seconds: 42
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert!(!cfg.redis.session_cache.enabled);
    assert_eq!(cfg.redis.session_cache.ttl_seconds, 42);
  }

  #[test]
  fn redis_roles_parse_url_and_namespace_overrides() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis:
  enabled: true
  namespace: "myoxus"
  roles:
    session:
      url: "redis://localhost:6380/2"
      namespace: "myoxus-session"
    lock:
      namespace: "myoxus-lock"
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(
      cfg.redis.role_url(RedisRole::Session),
      Some("redis://localhost:6380/2".to_string())
    );
    assert_eq!(cfg.redis.role_namespace(RedisRole::Session), "myoxus-session");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Lock), "myoxus-lock");
    assert_eq!(cfg.redis.role_namespace(RedisRole::Queue), "myoxus:queue");
    // Redis namespace resolution works correctly regardless of per-role URL overrides
    assert_eq!(cfg.redis.role_namespace(RedisRole::Queue), "myoxus:queue");
  }

  #[test]
  fn storage_config_min_free_space_defaults_to_zero() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.storage.min_free_space_mb, 0);
    assert_eq!(cfg.storage.min_free_space_bytes(), 0);
  }

  #[test]
  fn storage_config_parses_min_free_space_override() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
  min_free_space_mb: 1
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.storage.min_free_space_mb, 1);
    assert_eq!(cfg.storage.min_free_space_bytes(), 1_048_576);
  }

  #[test]
  fn logging_config_defaults_when_missing() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    // Default includes per-module directives (noisy deps at warn)
    assert!(
      cfg.logging.level.starts_with("info"),
      "level must start with 'info', got: {}",
      cfg.logging.level
    );
    assert!(
      cfg.logging.level.contains("sqlx::query=warn"),
      "level must suppress sqlx at warn"
    );
    assert_eq!(cfg.logging.rotation, LogRotation::Daily);
    assert_eq!(cfg.logging.max_files, 7);
    assert!(cfg.logging.file_path.is_none());
  }

  #[test]
  fn logging_config_parses_file_and_rotation() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
logging:
  level: "debug"
  file_path: "./logs/myoxus.log"
  rotation: "hourly"
  max_files: 12
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.logging.level, "debug");
    assert_eq!(cfg.logging.rotation, LogRotation::Hourly);
    assert_eq!(cfg.logging.max_files, 12);
    assert_eq!(cfg.logging.file_path.as_deref(), Some("./logs/myoxus.log"));
  }

  #[test]
  fn compat_config_defaults_to_pro_quota_plan() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.compat.quota_plan, QuotaPlan::Pro);
    assert_eq!(cfg.compat.quota.blob_limit, i32::MAX);
    assert_eq!(cfg.compat.quota.storage_quota, i64::MAX);
    assert_eq!(cfg.compat.quota.history_period, i32::MAX);
    assert_eq!(cfg.compat.quota.member_limit, i32::MAX);
    assert_eq!(cfg.compat.quota.copilot_limit, i64::MAX);
    assert_eq!(cfg.compat.quota.copilot_used, 0);
    assert_eq!(cfg.compat.billing.plan, BillingPlan::SelfHostedTeam);
    assert_eq!(cfg.compat.billing.recurring, BillingRecurring::Lifetime);
    assert_eq!(cfg.compat.billing.subscription.default_status, BillingStatus::Active);
    assert_eq!(cfg.compat.billing.subscription.cancel_status, BillingStatus::Canceled);
    assert!(
      cfg.compat.features.user.is_empty(),
      "static default user features must not reintroduce plan or quota flags"
    );
    assert!(
      cfg.compat.features.workspace.is_empty(),
      "static default workspace features must not reintroduce plan or quota flags"
    );
  }

  #[test]
  fn compat_config_parses_quota_plan_override() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
compat:
  quota_plan: "unlimited"
  quota:
    blob_limit: 2048
    storage_quota: 999999
    history_period: 365
    member_limit: 500
    copilot_limit: 4200
    copilot_used: 7
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.compat.quota_plan, QuotaPlan::Unlimited);
    assert_eq!(cfg.compat.quota.blob_limit, 2048);
    assert_eq!(cfg.compat.quota.storage_quota, 999999);
    assert_eq!(cfg.compat.quota.history_period, 365);
    assert_eq!(cfg.compat.quota.member_limit, 500);
    assert_eq!(cfg.compat.quota.copilot_limit, 4200);
    assert_eq!(cfg.compat.quota.copilot_used, 7);
  }

  #[test]
  fn compat_config_parses_billing_override() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
compat:
  billing:
    plan: "pro"
    recurring: "yearly"
    currency: "EUR"
    prices:
      type: "custom"
      amount: 1999
      yearly_amount: 999
      lifetime_amount: 29999
    subscription:
      id: "cfg-sub"
      default_status: "paused"
      cancel_status: "canceled"
      variant: "ea"
    license:
      quantity: 42
      recurring: "monthly"
      variant: "ea"
    portal:
      checkout_path: "/checkout"
      customer_portal_path: "/portal"
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(cfg.compat.billing.plan, BillingPlan::Pro);
    assert_eq!(cfg.compat.billing.recurring, BillingRecurring::Yearly);
    assert_eq!(cfg.compat.billing.currency, "EUR");
    assert_eq!(cfg.compat.billing.prices.type_name, "custom");
    assert_eq!(cfg.compat.billing.prices.amount, Some(1999));
    assert_eq!(cfg.compat.billing.subscription.id, "cfg-sub");
    assert_eq!(cfg.compat.billing.subscription.default_status, BillingStatus::Paused);
    assert_eq!(cfg.compat.billing.license.quantity, 42);
    assert_eq!(cfg.compat.billing.license.recurring, BillingRecurring::Monthly);
    assert_eq!(cfg.compat.billing.portal.checkout_path, "/checkout");
    assert_eq!(cfg.compat.billing.portal.customer_portal_path, "/portal");
  }

  #[test]
  fn load_features_file_parses_yaml_features() {
    let ts = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    let dir = std::env::temp_dir().join(format!("myoxus-config-test-{ts}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    let file_path = dir.join("features.user.yaml");
    fs::write(
      &file_path,
      r#"
features:
  - ProPlan
  - UnlimitedWorkspace
  - UnlimitedCopilot
  - ProPlan
  - EarlyAccess
"#,
    )
    .expect("write test file");
    let parsed =
      load_features_file(&dir, "features.user.yaml", vec![CompatibilityFeature::FreePlan]).expect("parse file");
    assert_eq!(
      parsed,
      vec![
        CompatibilityFeature::UnlimitedCopilot,
        CompatibilityFeature::EarlyAccess
      ]
    );
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn load_features_file_keeps_empty_feature_files_empty() {
    let ts = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    let dir = std::env::temp_dir().join(format!("myoxus-config-test-empty-{ts}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    fs::write(dir.join("features.workspace.yaml"), "features: []").expect("write test file");
    let parsed = load_features_file(
      &dir,
      "features.workspace.yaml",
      vec![CompatibilityFeature::TeamPlan, CompatibilityFeature::TeamPlan],
    )
    .expect("parse file");
    assert!(
      parsed.is_empty(),
      "an explicit empty static feature file is the neutral product default"
    );
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn load_features_file_strips_admin_from_static_sets() {
    let ts = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_nanos();
    let dir = std::env::temp_dir().join(format!("myoxus-config-test-admin-{ts}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    fs::write(
      dir.join("features.user.yaml"),
      r#"
features:
  - Admin
  - ProPlan
  - UnlimitedCopilot
  - Manager
"#,
    )
    .expect("write test file");
    let parsed = load_features_file(
      &dir,
      "features.user.yaml",
      vec![CompatibilityFeature::Admin, CompatibilityFeature::ProPlan],
    )
    .expect("parse file");
    assert_eq!(
      parsed,
      vec![CompatibilityFeature::UnlimitedCopilot, CompatibilityFeature::Manager]
    );
    let _ = fs::remove_dir_all(&dir);
  }

  // --- API-RV-09c: doc_service.endpoint startup validation ---

  /// Helper: validate a doc_service endpoint value.
  fn validate_endpoint(endpoint: Option<&str>) -> Result<(), ConfigError> {
    super::validate_doc_service_endpoint(endpoint)
  }

  #[test]
  fn doc_service_endpoint_none_is_ok() {
    assert!(validate_endpoint(None).is_ok());
  }

  #[test]
  fn doc_service_endpoint_empty_is_ok() {
    assert!(validate_endpoint(Some("")).is_ok());
    assert!(validate_endpoint(Some("  ")).is_ok());
  }

  #[test]
  fn doc_service_endpoint_https_is_ok() {
    assert!(validate_endpoint(Some("https://doc.example.com")).is_ok());
    assert!(validate_endpoint(Some("https://10.0.0.5:8443/docs")).is_ok());
  }

  #[test]
  fn doc_service_endpoint_localhost_http_is_ok() {
    assert!(validate_endpoint(Some("http://localhost:3000")).is_ok());
    assert!(validate_endpoint(Some("http://127.0.0.1:3000")).is_ok());
  }

  #[test]
  fn doc_service_endpoint_plain_http_rejected() {
    let err = validate_endpoint(Some("http://doc.internal:3000")).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("must use HTTPS"), "unexpected error: {msg}");
  }

  #[test]
  fn doc_service_endpoint_aws_metadata_rejected() {
    let err = validate_endpoint(Some("http://169.254.169.254/latest/meta-data/")).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("blocked metadata service"), "unexpected error: {msg}");
  }

  #[test]
  fn doc_service_endpoint_gcp_metadata_rejected() {
    let err = validate_endpoint(Some("http://metadata.google.internal/computeMetadata/v1/")).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("blocked metadata service"), "unexpected error: {msg}");
  }

  #[test]
  fn doc_service_endpoint_metadata_blocked_even_with_https() {
    // HTTPS to a metadata endpoint is still suspicious/blocked
    let err = validate_endpoint(Some("https://169.254.169.254/")).unwrap_err();
    assert!(err.to_string().contains("blocked metadata service"));
  }

  #[test]
  fn doc_service_endpoint_alibaba_metadata_rejected() {
    let err = validate_endpoint(Some("http://100.100.100.200/latest/meta-data/")).unwrap_err();
    assert!(err.to_string().contains("blocked metadata service"));
  }

  // ── P34-B-03: Tuning parameter validation ───────────────────────────

  /// Build a minimal AppConfig with defaults overridden for specific tuning
  /// fields. Only `validate_tuning_parameters` reads these fields, so
  /// everything else can use dummy values.
  fn make_tuning_cfg(
    broadcast_cap: usize,
    io_timeout: u64,
    proxy_timeout: u64,
    doc_maint_ms: u64,
    indexer_ms: u64,
    database_projection_ms: u64,
    calendar_ms: u64,
  ) -> AppConfig {
    // Parse the minimum valid YAML and then patch the tuning fields.
    let yaml = r#"
server:
  host: "127.0.0.1"
  port: 3001
  origin: "http://localhost:3010"
  session_ttl: 86400
  session_ttr: 3600
database:
  url: "postgres://localhost/test"
mail:
  sender: "noreply@test.local"
  smtp_port: 587
storage:
  backend: local
oauth:
  providers: {}
"#;
    let s = config::Config::builder()
      .add_source(config::File::from_str(
        &serde_json::to_string(&decode_config_document(yaml, ConfigDocumentFormat::Yaml).expect("decode test config"))
          .expect("serialize test config"),
        config::FileFormat::Json,
      ))
      .build()
      .expect("build test config");
    let mut cfg: AppConfig = s.try_deserialize().expect("deserialize test config");
    cfg.websocket.broadcast_channel_capacity = broadcast_cap;
    cfg.storage.io_timeout_seconds = io_timeout;
    cfg.http.proxy_timeout_seconds = proxy_timeout;
    cfg.worker.polling.doc_maintenance_interval_ms = doc_maint_ms;
    cfg.worker.polling.indexer_auto_index_interval_ms = indexer_ms;
    cfg.worker.polling.database_projection_interval_ms = database_projection_ms;
    cfg.worker.polling.calendar_reminder_interval_ms = calendar_ms;
    cfg
  }

  #[test]
  fn tuning_defaults_pass_validation() {
    let cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    assert!(super::validate_tuning_parameters(&cfg).is_ok());
  }

  #[test]
  fn tuning_broadcast_capacity_below_16_rejected() {
    let cfg = make_tuning_cfg(15, 15, 10, 120_000, 30_000, 30_000, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("broadcast_channel_capacity"), "{err}");
  }

  #[test]
  fn tuning_broadcast_capacity_16_accepted() {
    let cfg = make_tuning_cfg(16, 15, 10, 120_000, 30_000, 30_000, 60_000);
    assert!(super::validate_tuning_parameters(&cfg).is_ok());
  }

  #[test]
  fn tuning_io_timeout_zero_rejected() {
    let cfg = make_tuning_cfg(4096, 0, 10, 120_000, 30_000, 30_000, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("io_timeout_seconds"), "{err}");
  }

  #[test]
  fn tuning_proxy_timeout_zero_rejected() {
    let cfg = make_tuning_cfg(4096, 15, 0, 120_000, 30_000, 30_000, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("proxy_timeout_seconds"), "{err}");
  }

  #[test]
  fn tuning_doc_maintenance_below_5s_rejected() {
    let cfg = make_tuning_cfg(4096, 15, 10, 4999, 30_000, 30_000, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("doc_maintenance_interval_ms"), "{err}");
  }

  #[test]
  fn tuning_indexer_interval_below_5s_rejected() {
    let cfg = make_tuning_cfg(4096, 15, 10, 120_000, 4999, 30_000, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("indexer_auto_index_interval_ms"), "{err}");
  }

  #[test]
  fn tuning_calendar_interval_below_5s_rejected() {
    let cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 4999);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("calendar_reminder_interval_ms"), "{err}");
  }

  #[test]
  fn tuning_database_projection_interval_below_5s_rejected() {
    let cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 4999, 60_000);
    let err = super::validate_tuning_parameters(&cfg).unwrap_err();
    assert!(err.to_string().contains("database_projection_interval_ms"), "{err}");
  }

  #[test]
  fn tuning_minimum_accepted_values() {
    // All fields at their absolute minimum accepted values
    let cfg = make_tuning_cfg(16, 1, 1, 5000, 5000, 5000, 5000);
    assert!(super::validate_tuning_parameters(&cfg).is_ok());
  }

  #[test]
  fn database_operational_config_accepts_canonical_yaml() {
    #[derive(Deserialize, Serialize)]
    struct Wrapper {
      #[serde(default)]
      job: JobConfig,
      #[serde(default)]
      worker: WorkerConfig,
      #[serde(default)]
      databases: DatabasesConfig,
    }

    let canonical_yaml = r#"
job:
  queues:
    database:
      concurrency: 7
worker:
  polling:
    database_projection_interval_ms: 6000
databases:
  max_fields_per_database: 77
"#;
    let canonical: Wrapper = decode_typed_yaml_document(canonical_yaml).expect("canonical database YAML parses");
    assert_eq!(canonical.job.queues.database.concurrency, 7);
    assert_eq!(canonical.worker.polling.database_projection_interval_ms, 6000);
    assert_eq!(canonical.databases.max_fields_per_database, 77);
  }

  #[test]
  fn database_config_pool_defaults() {
    // When only `url` is specified, pool options must default to safe production values.
    // This is a regression guard for LRN-20260311-098: bare PgPool::connect() used SQLx
    // default of 10 connections, causing pool exhaustion under worker + WS load.
    let cfg: DatabaseConfig = decode_typed_yaml_document(r#"url: "postgres://localhost/test""#).expect("parse");
    assert_eq!(cfg.max_connections, 50, "default pool size should be 50");
    assert_eq!(cfg.min_connections, 2);
    assert_eq!(
      cfg.acquire_timeout_seconds, 5,
      "acquire_timeout must be short to fail-fast WebSocket ACK handlers"
    );
  }

  #[test]
  fn database_config_pool_overrideable() {
    let cfg: DatabaseConfig = decode_typed_yaml_document(
      r#"
url: "postgres://localhost/test"
max_connections: 100
min_connections: 5
acquire_timeout_seconds: 10
"#,
    )
    .expect("parse");
    assert_eq!(cfg.max_connections, 100);
    assert_eq!(cfg.min_connections, 5);
    assert_eq!(cfg.acquire_timeout_seconds, 10);
  }

  /// P32-D-04: WebSocket maxHttpBufferSize defaults to 100 MB (104857600)
  /// when the `websocket` section is present but `max_http_buffer_size_mb` is
  /// omitted. This is the serde field default, matching the value in
  /// `default.yaml`. The old socketioxide library default was only 100 KB.
  #[test]
  fn websocket_max_http_buffer_size_defaults_to_100mb() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
websocket:
  transports: ["websocket", "polling"]
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    // Must be 100 MB = 104857600, NOT the old socketioxide default of 100 KB
    assert_eq!(
      cfg.websocket.max_http_buffer_size(),
      104_857_600,
      "maxHttpBufferSize must default to 100 MB (104857600 bytes)"
    );
    // Sanity: must exceed the old default that caused large-doc failures
    assert!(
      cfg.websocket.max_http_buffer_size() > 102_400,
      "maxHttpBufferSize must be larger than the old 100 KB default"
    );
  }

  /// P32-D-04: WebSocket maxHttpBufferSize respects explicit override.
  #[test]
  fn websocket_max_http_buffer_size_parses_override() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
websocket:
  max_http_buffer_size_mb: 200
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert_eq!(
      cfg.websocket.max_http_buffer_size(),
      209_715_200,
      "maxHttpBufferSize must respect explicit 200 MB override"
    );
  }

  #[test]
  fn websocket_connection_admission_defaults_to_ten_and_rejects_invalid_bounds() {
    let defaults = WebSocketConfig::default();
    assert_eq!(defaults.max_connections_per_second_per_client, 10);

    let parsed: WebSocketConfig =
      decode_typed_yaml_document("transports: [websocket]\n").expect("minimal WebSocket config");
    assert_eq!(parsed.max_connections_per_second_per_client, 10);

    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.websocket.max_connections_per_second_per_client = 0;
    assert!(validate_tuning_parameters(&cfg).is_err());
    cfg.websocket.max_connections_per_second_per_client = 101;
    assert!(validate_tuning_parameters(&cfg).is_err());
    cfg.websocket.max_connections_per_second_per_client = 100;
    assert!(validate_tuning_parameters(&cfg).is_ok());
  }

  // ── P36-D-01: Git Sync config defaults ──────────────────────────────

  #[test]
  fn git_sync_defaults_are_correct() {
    let cfg = GitSyncPolicyConfig::default();
    assert!(cfg.enabled);
    assert_eq!(cfg.retention_days, 7);
    assert_eq!(cfg.network_timeout_secs, 120);
    assert_eq!(cfg.local_timeout_secs, 30);
    assert_eq!(cfg.max_docs_per_sync, 0); // unlimited
    assert_eq!(cfg.clone_depth, 1);
    assert_eq!(cfg.push_max_retries, 1);
    assert_eq!(cfg.commit_author_name, "Myoxus Sync");
    assert_eq!(cfg.commit_author_email, "sync@myoxus.local");
    assert_eq!(cfg.parallel_conversion_threshold, 10);
    assert_eq!(cfg.max_mirror_storage_mb, 1024);
    assert_eq!(cfg.min_free_disk_mb, 500);
    assert_eq!(cfg.default_branch, "main");
    assert_eq!(cfg.ssh_host_key_policy, SshHostKeyPolicy::AcceptNew);
    assert_eq!(cfg.https_certificate_policy, HttpsCertificatePolicy::Strict);
    assert_eq!(cfg.https_ca_bundle_path, None);
  }

  #[test]
  fn git_sync_yaml_overrides_work() {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
websocket:
  transports: ["websocket", "polling"]
git_sync:
  enabled: false
  retention_days: 14
  clone_depth: 5
  push_max_retries: 3
  commit_author_name: "Custom Bot"
  commit_author_email: "bot@example.com"
  max_mirror_storage_mb: 2048
  min_free_disk_mb: 100
  network_timeout_secs: 60
  parallel_conversion_threshold: 20
  ssh_host_key_policy: "strict"
  https_certificate_policy: "insecure_no_verify"
  https_ca_bundle_path: "git-sync/company-ca.pem"
  allowed_hosts: ["git.example.test"]
"#;
    let cfg: AppConfig = decode_typed_yaml_document(raw).expect("config parse");
    assert!(!cfg.git_sync.enabled);
    assert_eq!(cfg.git_sync.retention_days, 14);
    assert_eq!(cfg.git_sync.clone_depth, 5);
    assert_eq!(cfg.git_sync.push_max_retries, 3);
    assert_eq!(cfg.git_sync.commit_author_name, "Custom Bot");
    assert_eq!(cfg.git_sync.commit_author_email, "bot@example.com");
    assert_eq!(cfg.git_sync.max_mirror_storage_mb, 2048);
    assert_eq!(cfg.git_sync.min_free_disk_mb, 100);
    assert_eq!(cfg.git_sync.network_timeout_secs, 60);
    assert_eq!(cfg.git_sync.parallel_conversion_threshold, 20);
    assert_eq!(cfg.git_sync.ssh_host_key_policy, SshHostKeyPolicy::Strict);
    assert_eq!(
      cfg.git_sync.https_certificate_policy,
      HttpsCertificatePolicy::InsecureNoVerify
    );
    assert_eq!(
      cfg.git_sync.https_ca_bundle_path.as_deref(),
      Some("git-sync/company-ca.pem")
    );
  }

  // ── P36-D-02: Git Sync validation tests ─────────────────────────────

  /// Helper: build a valid GitSyncPolicyConfig and override one field for testing.
  fn git_sync_with<F: FnOnce(&mut GitSyncPolicyConfig)>(f: F) -> GitSyncPolicyConfig {
    let mut cfg = GitSyncPolicyConfig::default();
    f(&mut cfg);
    cfg
  }

  #[test]
  fn git_sync_validation_rejects_zero_network_timeout() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.network_timeout_secs = 0);
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("network_timeout_secs"));
  }

  #[test]
  fn git_sync_retention_rejects_an_off_mode_and_out_of_range_startup_values() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    for days in [0, 31] {
      cfg.git_sync.retention_days = days;
      assert!(
        validate_tuning_parameters(&cfg)
          .unwrap_err()
          .to_string()
          .contains("git_sync.retention_days")
      );
    }
    for days in [1, 30] {
      cfg.git_sync.retention_days = days;
      assert!(validate_tuning_parameters(&cfg).is_ok());
    }
    assert!(decode_typed_yaml_document::<GitSyncPolicyConfig>("retention_days: 1.5").is_err());
  }

  #[test]
  fn git_sync_validation_rejects_insecure_https_without_allowed_host() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| {
      gs.https_certificate_policy = HttpsCertificatePolicy::InsecureNoVerify;
      gs.allowed_hosts.clear();
    });
    let error = validate_tuning_parameters(&cfg).expect_err("empty host allowlist must fail closed");
    assert!(error.to_string().contains("allowed_hosts"));
  }

  #[test]
  fn git_sync_validation_accepts_insecure_https_for_explicit_allowed_host() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| {
      gs.https_certificate_policy = HttpsCertificatePolicy::InsecureNoVerify;
      gs.allowed_hosts = vec!["git.example.test".to_string()];
    });
    validate_tuning_parameters(&cfg).expect("explicit host allowlist should permit the policy");
  }

  #[test]
  fn git_sync_ca_bundle_path_rejects_absolute_and_parent_paths() {
    assert!(validate_git_sync_ca_bundle_relative_path("git-sync/company-ca.pem").is_ok());
    assert!(validate_git_sync_ca_bundle_relative_path("").is_ok());
    assert!(validate_git_sync_ca_bundle_relative_path("/etc/ssl/company.pem").is_err());
    assert!(validate_git_sync_ca_bundle_relative_path("../company.pem").is_err());
  }

  fn test_certificate_pem(is_ca: bool, not_before: i64, not_after: i64) -> Vec<u8> {
    use openssl::asn1::{Asn1Integer, Asn1Time};
    use openssl::bn::BigNum;
    use openssl::ec::{EcGroup, EcKey};
    use openssl::hash::MessageDigest;
    use openssl::nid::Nid;
    use openssl::pkey::PKey;
    use openssl::x509::extension::{BasicConstraints, KeyUsage};
    use openssl::x509::{X509Builder, X509NameBuilder};

    let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).expect("test curve");
    let key = PKey::from_ec_key(EcKey::generate(&group).expect("test EC key")).expect("test key");
    let mut name = X509NameBuilder::new().expect("test subject");
    name
      .append_entry_by_text(
        "CN",
        if is_ca {
          "Git-Sync test CA"
        } else {
          "Git-Sync test leaf"
        },
      )
      .expect("test common name");
    let name = name.build();
    let serial = Asn1Integer::from_bn(&BigNum::from_u32(if is_ca { 1 } else { 2 }).expect("test serial"))
      .expect("test serial integer");
    let mut certificate = X509Builder::new().expect("test certificate");
    certificate.set_version(2).expect("test version");
    certificate.set_serial_number(&serial).expect("test serial");
    certificate.set_subject_name(&name).expect("test subject");
    certificate.set_issuer_name(&name).expect("test issuer");
    certificate.set_pubkey(&key).expect("test public key");
    certificate
      .set_not_before(Asn1Time::from_unix(not_before).expect("test not-before").as_ref())
      .expect("set test not-before");
    certificate
      .set_not_after(Asn1Time::from_unix(not_after).expect("test not-after").as_ref())
      .expect("set test not-after");
    let mut constraints = BasicConstraints::new();
    constraints.critical();
    if is_ca {
      constraints.ca();
    }
    certificate
      .append_extension(constraints.build().expect("test basic constraints"))
      .expect("append test basic constraints");
    let mut key_usage = KeyUsage::new();
    key_usage.critical();
    if is_ca {
      key_usage.key_cert_sign().crl_sign();
    } else {
      key_usage.digital_signature();
    }
    certificate
      .append_extension(key_usage.build().expect("test key usage"))
      .expect("append test key usage");
    certificate
      .sign(&key, MessageDigest::sha256())
      .expect("sign test certificate");
    certificate.build().to_pem().expect("test PEM")
  }

  #[test]
  fn ca_snapshot_survives_replacement_and_cleans_up_after_last_owner() {
    myoxus_infrastructure::tls::initialize_crypto_provider();
    let now = chrono::Utc::now().timestamp();
    let root = tempfile::tempdir().expect("CA fixture root");
    let original = test_certificate_pem(true, now - 60, now + 3600);
    std::fs::write(root.path().join("ca.pem"), &original).expect("CA fixture");
    let bundle = myoxus_infrastructure::tls::load_bundle(root.path(), "ca.pem")
      .unwrap()
      .unwrap();
    let held = bundle.clone();
    let materialized = bundle.materialized_path().to_path_buf();
    assert_eq!(std::fs::read(&materialized).unwrap(), original);
    std::fs::write(root.path().join("ca.pem"), "invalid replacement").unwrap();
    assert!(myoxus_infrastructure::tls::load_bundle(root.path(), "ca.pem").is_err());
    assert_eq!(bundle.pem(), original);
    assert_eq!(std::fs::read(&materialized).unwrap(), original);
    assert!(
      myoxus_infrastructure::tls::add_reqwest_roots(reqwest::Client::builder(), &bundle)
        .unwrap()
        .build()
        .is_ok()
    );
    drop(bundle);
    assert!(materialized.exists());
    drop(held);
    assert!(!materialized.exists());
  }

  #[test]
  fn git_sync_ca_bundle_validation_accepts_only_current_ca_certificates() {
    let now = chrono::Utc::now().timestamp();
    let root = tempfile::tempdir().expect("CA fixture root");
    let valid = root.path().join("valid.pem");
    std::fs::write(&valid, test_certificate_pem(true, now - 60, now + 3600)).expect("valid CA fixture");
    assert_eq!(validate_git_sync_ca_bundle(&valid).expect("valid CA bundle"), 1);

    let leaf = root.path().join("leaf.pem");
    std::fs::write(&leaf, test_certificate_pem(false, now - 60, now + 3600)).expect("leaf fixture");
    let leaf_error = validate_git_sync_ca_bundle(&leaf).expect_err("leaf must not become a trust anchor");
    assert!(leaf_error.to_string().contains("not a CA certificate"));

    let expired = root.path().join("expired.pem");
    std::fs::write(&expired, test_certificate_pem(true, now - 3600, now - 60)).expect("expired CA fixture");
    let expired_error = validate_git_sync_ca_bundle(&expired).expect_err("expired CA must fail startup");
    assert!(expired_error.to_string().contains("not currently valid"));
  }

  #[test]
  fn git_sync_ca_bundle_validation_rejects_empty_malformed_and_non_certificate_pem() {
    let root = tempfile::tempdir().expect("CA fixture root");
    let empty = root.path().join("empty.pem");
    std::fs::write(&empty, []).expect("empty fixture");
    assert!(
      validate_git_sync_ca_bundle(&empty)
        .expect_err("empty bundle")
        .to_string()
        .contains("empty")
    );

    let malformed = root.path().join("malformed.pem");
    std::fs::write(&malformed, "-----BEGIN CERTIFICATE-----\nnot-base64\n").expect("malformed fixture");
    assert!(
      validate_git_sync_ca_bundle(&malformed)
        .expect_err("malformed bundle")
        .to_string()
        .contains("malformed")
    );

    let private_key = root.path().join("private-key.pem");
    let key = openssl::pkey::PKey::from_ec_key(
      openssl::ec::EcKey::generate(
        &openssl::ec::EcGroup::from_curve_name(openssl::nid::Nid::X9_62_PRIME256V1).expect("test curve"),
      )
      .expect("test key"),
    )
    .expect("test PKey");
    std::fs::write(
      &private_key,
      key.private_key_to_pem_pkcs8().expect("test private-key PEM"),
    )
    .expect("private-key fixture");
    let key_error = validate_git_sync_ca_bundle(&private_key).expect_err("private key must be rejected");
    assert!(key_error.to_string().contains("not a CERTIFICATE block"));
  }

  #[test]
  fn git_sync_ca_bundle_resolution_stays_below_runtime_config_root() {
    let root = tempfile::tempdir().expect("runtime config root");
    let bundle_dir = root.path().join("git-sync");
    std::fs::create_dir(&bundle_dir).expect("bundle directory");
    let bundle = bundle_dir.join("company-ca.pem");
    std::fs::write(&bundle, "test bundle").expect("bundle");

    assert_eq!(
      resolve_git_sync_ca_bundle_below_root(root.path(), "git-sync/company-ca.pem").expect("safe bundle"),
      bundle.canonicalize().expect("canonical bundle")
    );
    assert!(resolve_git_sync_ca_bundle_below_root(root.path(), "git-sync/missing.pem").is_err());

    #[cfg(unix)]
    {
      let outside = tempfile::NamedTempFile::new().expect("outside bundle");
      std::os::unix::fs::symlink(outside.path(), bundle_dir.join("escaped.pem")).expect("symlink");
      assert!(resolve_git_sync_ca_bundle_below_root(root.path(), "git-sync/escaped.pem").is_err());
    }
  }

  #[test]
  fn git_sync_validation_rejects_zero_local_timeout() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.local_timeout_secs = 0);
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("local_timeout_secs"));
  }

  #[test]
  fn git_sync_validation_rejects_zero_clone_depth() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.clone_depth = 0);
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("clone_depth"));
  }

  #[test]
  fn git_sync_validation_rejects_empty_author_name() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.commit_author_name = "  ".to_string());
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("commit_author_name"));
  }

  #[test]
  fn git_sync_validation_rejects_empty_author_email() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.commit_author_email = String::new());
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("commit_author_email"));
  }

  #[test]
  fn git_sync_validation_rejects_zero_parallel_threshold() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| gs.parallel_conversion_threshold = 0);
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_err());
    assert!(
      result
        .unwrap_err()
        .to_string()
        .contains("parallel_conversion_threshold")
    );
  }

  #[test]
  fn git_sync_validation_accepts_valid_defaults() {
    let cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    let result = validate_tuning_parameters(&cfg);
    assert!(result.is_ok(), "default config must pass validation: {result:?}");
  }

  #[test]
  fn git_sync_validation_requires_secret_when_webhooks_are_enabled() {
    let mut cfg = make_tuning_cfg(4096, 15, 10, 120_000, 30_000, 30_000, 60_000);
    cfg.git_sync = git_sync_with(|gs| {
      gs.webhook_allowed = true;
      gs.webhook_secret = None;
    });
    let err = validate_tuning_parameters(&cfg).unwrap_err().to_string();
    assert!(err.contains("webhook_secret"), "got: {err}");

    cfg.git_sync.webhook_secret = Some("secret".to_string());
    assert!(validate_tuning_parameters(&cfg).is_ok());
  }

  // --- M-JOB-A1: JobConfig typed struct tests ---

  #[test]
  fn job_queue_defaults_match_legacy_json_shape() {
    let defaults = JobQueueDefaults::default();
    let json = serde_json::to_value(&defaults).expect("serialize");
    assert_eq!(json["attempts"], 5);
    assert_eq!(json["backoff"]["type"], "exponential");
    assert_eq!(json["backoff"]["delay"], 1000);
    assert_eq!(json["removeOnComplete"], true);
    assert_eq!(json["removeOnFail"]["age"], 86400);
    assert_eq!(json["removeOnFail"]["count"], 500);
  }

  #[test]
  fn job_worker_defaults_has_poll_timeout() {
    let defaults = JobWorkerDefaults::default();
    assert_eq!(defaults.poll_timeout_seconds, 5);
    let json = serde_json::to_value(&defaults).expect("serialize");
    assert_eq!(json["pollTimeoutSeconds"], 5);
  }

  #[test]
  fn job_queue_defaults_roundtrip_preserves_values() {
    let original = JobQueueDefaults {
      attempts: 10,
      backoff: JobBackoffConfig {
        backoff_type: "fixed".to_string(),
        delay: 2000,
      },
      remove_on_complete: false,
      remove_on_fail: JobRemoveOnFailConfig { age: 3600, count: 100 },
    };
    let json = serde_json::to_value(&original).expect("serialize");
    let restored: JobQueueDefaults = serde_json::from_value(json.clone()).expect("deserialize");
    assert_eq!(restored.attempts, 10);
    assert_eq!(restored.backoff.backoff_type, "fixed");
    assert_eq!(restored.backoff.delay, 2000);
    assert!(!restored.remove_on_complete);
    assert_eq!(restored.remove_on_fail.age, 3600);
    assert_eq!(restored.remove_on_fail.count, 100);
    // Verify camelCase keys in JSON
    assert!(json.get("removeOnComplete").is_some(), "must use camelCase key");
    assert!(json.get("removeOnFail").is_some(), "must use camelCase key");
    assert!(
      json["backoff"].get("type").is_some(),
      "backoff must use 'type' not 'backoff_type'"
    );
  }

  #[test]
  fn job_config_yaml_deserialization_matches_default_yaml() {
    let yaml = r#"
job:
  queue:
    attempts: 5
    backoff:
      type: "exponential"
      delay: 1000
    removeOnComplete: true
    removeOnFail:
      age: 86400
      count: 500
  worker:
    pollTimeoutSeconds: 5
  queues:
    copilot:
      concurrency: 2
    doc:
      concurrency: 1
    indexer:
      concurrency: 3
    notification:
      concurrency: 4
    nightly:
      concurrency: 1
    calendar-reminder:
      concurrency: 2
    git-sync:
      concurrency: 1
    template-registry:
      concurrency: 1
"#;

    #[derive(Deserialize, Serialize)]
    struct Wrapper {
      job: JobConfig,
    }
    let cfg: Wrapper = decode_typed_yaml_document(yaml).expect("YAML parse");
    assert_eq!(cfg.job.queue.attempts, 5);
    assert_eq!(cfg.job.queue.backoff.backoff_type, "exponential");
    assert_eq!(cfg.job.queue.backoff.delay, 1000);
    assert!(cfg.job.queue.remove_on_complete);
    assert_eq!(cfg.job.queue.remove_on_fail.age, 86400);
    assert_eq!(cfg.job.queue.remove_on_fail.count, 500);
    assert_eq!(cfg.job.worker.poll_timeout_seconds, 5);
    assert_eq!(cfg.job.queues.copilot.concurrency, 2);
    assert_eq!(cfg.job.queues.doc.concurrency, 1);
    assert_eq!(cfg.job.queues.indexer.concurrency, 3);
    assert_eq!(cfg.job.queues.notification.concurrency, 4);
    assert_eq!(cfg.job.queues.nightly.concurrency, 1);
    assert_eq!(cfg.job.queues.calendar_reminder.concurrency, 2);
    assert_eq!(cfg.job.queues.git_sync.concurrency, 1);
    assert_eq!(cfg.job.queues.template_registry.concurrency, 1);
    assert_eq!(cfg.job.queues.database.concurrency, 1);
    assert_eq!(cfg.job.queues.workspace_content_operation.concurrency, 1);
  }

  #[test]
  fn job_worker_poll_timeout_override() {
    let yaml = r#"
job:
  worker:
    pollTimeoutSeconds: 10
  queue: {}
"#;
    #[derive(Deserialize, Serialize)]
    struct Wrapper {
      job: JobConfig,
    }
    let cfg: Wrapper = decode_typed_yaml_document(yaml).expect("YAML parse");
    assert_eq!(cfg.job.worker.poll_timeout_seconds, 10);
  }

  // ── P-Captcha-A: INV-CAPTCHA-01 start-check ─────────────────────────────

  fn minimal_cfg_with_captcha(c: CaptchaConfig) -> AppConfig {
    let raw = r#"
server:
  port: 3001
  host: "0.0.0.0"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database: { url: "postgres://localhost/a" }
redis: { url: "redis://localhost:6379", namespace: "myoxus" }
mail:
  sender: "noreply@test"
  smtp_port: 587
storage:
  backend: "local"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#;
    let mut cfg: AppConfig = decode_typed_yaml_document(raw).expect("cfg parse");
    cfg.captcha = c;
    cfg
  }

  #[test]
  fn captcha_disabled_passes_validation() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig::default());
    assert!(cfg.validate_captcha_config().is_ok());
  }

  #[test]
  fn database_overrides_reject_cross_field_drift_before_runtime_projection() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig::default());
    let overrides = HashMap::from([
      (
        "workspace.import.max_entry_bytes".to_string(),
        serde_json::json!(8_388_608),
      ),
      (
        "workspace.import.max_expanded_bytes".to_string(),
        serde_json::json!(4_194_304),
      ),
    ]);

    let error = cfg
      .with_database_overrides(&overrides)
      .expect_err("entry limit above expanded limit must reject the complete candidate");
    assert!(
      error
        .to_string()
        .contains("workspace.import.max_entry_bytes must not exceed max_expanded_bytes")
    );
  }

  #[test]
  fn database_overrides_preserve_yaml_only_git_sync_webhook_secret() {
    let mut cfg = minimal_cfg_with_captcha(CaptchaConfig::default());
    cfg.git_sync.enabled = true;
    cfg.git_sync.webhook_allowed = true;
    cfg.git_sync.webhook_secret = Some("yaml-only-webhook-secret".to_string());

    let projected = cfg
      .with_database_overrides(&HashMap::from([(
        "git_sync.enabled".to_string(),
        serde_json::json!(true),
      )]))
      .expect("database projection must retain the non-serializable webhook secret");

    assert_eq!(
      projected.git_sync.webhook_secret.as_deref(),
      Some("yaml-only-webhook-secret")
    );
    assert!(projected.git_sync.webhook_allowed);
  }

  #[test]
  fn captcha_enabled_without_hmac_key_fails() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: String::new(),
      ..Default::default()
    });
    let err = cfg.validate_captcha_config().unwrap_err().to_string();
    assert!(err.contains("hmac_key is empty"), "got: {err}");
  }

  #[test]
  fn captcha_enabled_with_whitespace_hmac_key_fails() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: "   ".to_string(),
      ..Default::default()
    });
    assert!(cfg.validate_captcha_config().is_err());
  }

  #[test]
  fn captcha_enabled_with_hmac_key_passes() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: "a".repeat(64),
      ..Default::default()
    });
    assert!(cfg.validate_captcha_config().is_ok());
  }

  #[test]
  fn captcha_rejects_unknown_algorithm() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: "a".repeat(64),
      algorithm: "Argon2id".to_string(), // only JS/Go support it
      ..Default::default()
    });
    let err = cfg.validate_captcha_config().unwrap_err().to_string();
    assert!(err.contains("algorithm"), "got: {err}");
  }

  #[test]
  fn captcha_rejects_zero_expiration() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: "a".repeat(64),
      challenge_expires_seconds: 0,
      ..Default::default()
    });
    assert!(cfg.validate_captcha_config().is_err());
  }

  #[test]
  fn captcha_rejects_empty_honeypot_name() {
    let cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: "a".repeat(64),
      honeypot_field_name: String::new(),
      ..Default::default()
    });
    assert!(cfg.validate_captcha_config().is_err());
  }

  // ── P-Captcha-A2: INV-CAPTCHA-08 auto-gen safety-net ────────────────────

  #[test]
  fn bootstrap_generates_hmac_key_when_enabled_and_empty() {
    let mut cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: String::new(),
      ..Default::default()
    });
    cfg.bootstrap_captcha_hmac_key();
    assert_eq!(
      cfg.captcha.hmac_key.len(),
      64,
      "expected 32 bytes hex-encoded (64 chars), got {}",
      cfg.captcha.hmac_key.len()
    );
    assert!(
      cfg.captcha.hmac_key.chars().all(|c| c.is_ascii_hexdigit()),
      "expected hex key, got: {}",
      cfg.captcha.hmac_key
    );
    assert!(cfg.validate_captcha_config().is_ok());
  }

  #[test]
  fn bootstrap_is_noop_when_hmac_key_already_set() {
    let preset = "deadbeef".repeat(8);
    let mut cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: true,
      hmac_key: preset.clone(),
      ..Default::default()
    });
    cfg.bootstrap_captcha_hmac_key();
    assert_eq!(cfg.captcha.hmac_key, preset);
  }

  #[test]
  fn bootstrap_is_noop_when_captcha_disabled() {
    let mut cfg = minimal_cfg_with_captcha(CaptchaConfig {
      enabled: false,
      hmac_key: String::new(),
      ..Default::default()
    });
    cfg.bootstrap_captcha_hmac_key();
    assert!(
      cfg.captcha.hmac_key.is_empty(),
      "disabled captcha should never auto-generate a key"
    );
  }

  // ─── P-Telemetry-A: TelemetryConfig parsing & helpers ──────────────────

  #[test]
  fn telemetry_config_defaults_match_spec() {
    let cfg = TelemetryConfig::default();
    assert!(cfg.enabled);
    assert_eq!(cfg.dedupe_ttl_hours, 1);
    assert_eq!(cfg.dedupe_max_entries, 100_000);
    assert_eq!(cfg.batch_max_events, 500);
    assert_eq!(cfg.flush_interval_seconds, 60);
    assert_eq!(cfg.retention_raw_days, 14);
    assert_eq!(cfg.retention_daily_days, 90);
    assert_eq!(cfg.ingest_rate_limit_per_ip_per_min, 600);
    // All canonical categories enabled with full sampling.
    for c in TELEMETRY_CATEGORIES {
      assert!(cfg.category_enabled(c), "default category {c} should be enabled");
      assert_eq!(cfg.sampling_rate(c), 1.0);
    }
  }

  #[test]
  fn telemetry_category_unknown_is_fail_closed() {
    let cfg = TelemetryConfig::default();
    assert!(
      !cfg.category_enabled("nonexistent_category"),
      "unknown category must be rejected (fail-closed per INV-TEL-02)"
    );
    assert_eq!(cfg.sampling_rate("nonexistent_category"), 0.0);
  }

  #[test]
  fn telemetry_sampling_rate_clamped() {
    let mut cfg = TelemetryConfig::default();
    cfg.sampling_rates.insert("page_view".into(), 2.5);
    cfg.sampling_rates.insert("doc_op".into(), -0.5);
    assert_eq!(cfg.sampling_rate("page_view"), 1.0);
    assert_eq!(cfg.sampling_rate("doc_op"), 0.0);
  }

  #[test]
  fn telemetry_config_accepts_legacy_allowed_origin_alias() {
    // Old YAML field name must still deserialize (soft-removal path).
    let raw = r#"
enabled: true
allowed_origin:
  - "https://legacy.example"
"#;
    let cfg: TelemetryConfig = decode_typed_yaml_document(raw).expect("legacy alias parses");
    assert_eq!(cfg.allowed_origins, vec!["https://legacy.example".to_string()]);
  }

  #[test]
  fn telemetry_config_ignores_removed_ga4_fields() {
    // Unknown GA4 fields on an otherwise-valid config must not crash parsing.
    let raw = r#"
enabled: true
ga4_measurement_id: "G-XXX"
ga4_api_secret: "shh"
"#;
    let cfg: TelemetryConfig = decode_typed_yaml_document(raw).expect("GA4 fields ignored, not rejected");
    assert!(cfg.enabled);
    // A deprecation warning is emitted at AppConfig::load() via
    // warn_deprecated_telemetry_keys — that path is not reachable from a bare
    // TelemetryConfig parse, but the warn_* helper is exercised in an
    // integration test (see compat_rest_endpoints.rs).
  }
}
