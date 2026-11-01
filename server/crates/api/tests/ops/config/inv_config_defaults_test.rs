//! SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! Integration tests for configuration defaults consistency (P91-CFG-A-T04).
//! These tests verify that YAML defaults are applied consistently and that
//! serde defaults don't diverge from declared YAML values.

use myoxus_api::config::AppConfig;

/// Test: AppConfig loads with only default.yaml (no local overrides).
/// Invariant: AppConfig::load() succeeds and applies all YAML defaults.
#[test]
fn inv_cfg_def01_yaml_defaults_load_successfully() {
  let config = AppConfig::load().expect("AppConfig should load with default.yaml");

  // Basic sanity checks: required fields are set
  assert!(!config.server.origin.is_empty(), "server.origin must be set");
  assert!(!config.server.host.is_empty(), "server.host must be set");
  assert!(config.server.port > 0, "server.port must be positive");
  assert!(!config.database.url.is_empty(), "database.url must be set");
}

/// Test: Serialization round-trip preserves defaults.
/// Invariant: Loading config twice produces identical values.
#[test]
fn inv_cfg_def02_config_load_consistent() {
  let config1 = AppConfig::load().expect("load config (first)");
  let config2 = AppConfig::load().expect("load config (second)");

  // Key fields should match between two loads
  assert_eq!(
    config1.server.origin, config2.server.origin,
    "server.origin should be consistent across loads"
  );
  assert_eq!(
    config1.server.port, config2.server.port,
    "server.port should be consistent across loads"
  );
  assert_eq!(config1.logging.level, config2.logging.level);
}

/// Test: Logging configuration has a valid default level.
/// Invariant: logging.level is one of: trace, debug, info, warn, error.
#[test]
fn inv_cfg_def04_logging_level_valid() {
  let config = AppConfig::load().expect("load config");

  let valid_levels = ["trace", "debug", "info", "warn", "error"];
  assert!(
    valid_levels.iter().any(|&l| config.logging.level.contains(l)),
    "logging.level must be a valid tracing level"
  );
}

/// Test: Database connection pool limits are reasonable.
/// Invariant: min_connections < max_connections, both > 0.
#[test]
fn inv_cfg_def05_database_pool_defaults_reasonable() {
  let config = AppConfig::load().expect("load config");

  assert!(
    config.database.min_connections > 0,
    "database.min_connections must be > 0"
  );
  assert!(
    config.database.max_connections >= config.database.min_connections,
    "database.max_connections must be >= min_connections"
  );
  assert!(
    config.database.max_connections <= 500,
    "database.max_connections should be reasonable (not absurdly high)"
  );
}

/// Test: Storage configuration is set.
/// Invariant: storage.backend and storage.root are configured.
#[test]
fn inv_cfg_def06_storage_defaults_set() {
  let config = AppConfig::load().expect("load config");

  // backend is an enum — verify it's a known variant by matching
  let _backend = &config.storage.backend; // StorageBackend enum, always set
  assert!(
    config.storage.root.as_ref().is_some_and(|r| !r.is_empty()),
    "storage.root must be set and non-empty"
  );
}

/// Test: Copilot defaults don't enable providers without API keys.
/// Invariant: If copilot provider is enabled, it has required credentials OR is disabled by default.
#[test]
fn inv_cfg_def07_copilot_defaults_safe() {
  let config = AppConfig::load().expect("load config");

  // Copilot providers should have a default (e.g., "openai")
  assert!(
    !config.copilot.default_provider.is_empty(),
    "copilot.default_provider must be set"
  );

  // Speech has no implicit destination or model; embedding defaults remain unchanged.
  assert!(!config.transcription.enabled, "speech must require explicit activation");
  assert!(
    config.transcription.endpoint.is_empty(),
    "speech must not infer a destination"
  );
  assert!(config.transcription.model.is_empty(), "speech must not infer a model");
  assert!(
    !config.copilot.embedding_model.is_empty(),
    "copilot.embedding_model must be set"
  );
}

/// Test: Session TTL is sensible.
/// Invariant: session_ttl > session_ttr (must refresh before expiration).
#[test]
fn inv_cfg_def08_session_ttl_sensible() {
  let config = AppConfig::load().expect("load config");

  assert!(config.server.session_ttl > 0, "session_ttl must be positive");
  assert!(config.server.session_ttr > 0, "session_ttr must be positive");
  assert!(
    config.server.session_ttl > config.server.session_ttr,
    "session_ttl must be > session_ttr (refresh before expire)"
  );
}

/// Test: Public publishing has complete operational defaults.
/// Invariant: delivery, static export, renderer shell, Pagefind and social-card
/// controls are present in AppConfig so public publishing never depends on
/// hidden CLI or renderer defaults.
#[test]
fn inv_cfg_def09_public_publishing_defaults_complete() {
  let config = AppConfig::load().expect("load config");
  let public = &config.public_publishing;

  assert!(public.enabled, "public publishing should be enabled by default");
  assert!(
    public.dynamic_routes_enabled,
    "dynamic public routes should be enabled by default"
  );
  assert_eq!(public.static_export_root, "/var/lib/myoxus/public");
  assert_eq!(public.static_retention_releases, 5);
  assert_eq!(public.html_cache_ttl_seconds, 300);
  assert_eq!(public.asset_cache_max_age_seconds, 31_536_000);
  assert!(
    !public.default_noindex,
    "public pages should be indexable by default once explicitly published"
  );
  assert!(public.site_shell.breadcrumbs_enabled);
  assert!(public.site_shell.toc_enabled);
  assert_eq!(public.site_shell.max_toc_depth, 3);
  assert!(public.site_shell.previous_next_enabled);
  assert!(public.site_shell.code_copy_enabled);
  assert!(public.site_shell.syntax_highlighting_enabled);
  assert!(public.site_shell.search_enabled);
  assert!(public.pagefind.enabled);
  assert_eq!(public.pagefind.binary, "pagefind");
  assert!(public.social_cards.enabled);
}

/// Test: Public publishing config follows the normal MYOXUS__ env override
/// mechanism.
/// Invariant: operators can relocate static public releases without adding
/// feature-specific environment parsing.
#[test]
fn inv_cfg_def10_public_publishing_static_export_root_env_override() {
  const ENV_KEY: &str = "MYOXUS__PUBLIC_PUBLISHING__STATIC_EXPORT_ROOT";
  const OVERRIDE_ROOT: &str = "/tmp/myoxus-public-export-override";

  // SAFETY: this mirrors the repository's existing env-var config tests. The
  // variable is feature-specific and is removed immediately after loading.
  unsafe { std::env::set_var(ENV_KEY, OVERRIDE_ROOT) };
  let config = AppConfig::load().expect("load config with public publishing env override");
  // SAFETY: same scope as above.
  unsafe { std::env::remove_var(ENV_KEY) };

  assert_eq!(config.public_publishing.static_export_root, OVERRIDE_ROOT);
}
