// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical configuration descriptors, provenance, and masking contracts.
//!
//! Every descriptor path is both the PostgreSQL row identifier and the exact
//! boot-readable serde/YAML path. Consumers must not translate or alias it.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Redacted value used by every external configuration projection.
pub const MASKED_CONFIG_VALUE: &str = "***REDACTED***";

/// Shared startup default for the per-process document decoder gate.
pub const DEFAULT_DOC_DECODER_CONCURRENCY: usize = 8;
/// Tokio's semaphore reserves three bits in its platform-sized permit counter.
pub const MAX_DOC_DECODER_CONCURRENCY: usize = usize::MAX >> 3;

pub fn validate_doc_decoder_concurrency(value: usize) -> Result<(), &'static str> {
  if value == 0 || value > MAX_DOC_DECODER_CONCURRENCY {
    return Err("doc.decoder_concurrency must be a positive integer within the semaphore/platform range");
  }
  Ok(())
}

fn doc_decoder_concurrency_from_value(value: &Value) -> Result<usize, &'static str> {
  let concurrency = value
    .as_u64()
    .and_then(|value| usize::try_from(value).ok())
    .ok_or("doc.decoder_concurrency must be a positive platform-sized integer")?;
  validate_doc_decoder_concurrency(concurrency)?;
  Ok(concurrency)
}

/// Preserve the source type: config's integer deserializer otherwise rounds floats.
pub fn deserialize_doc_decoder_concurrency<'de, D: serde::Deserializer<'de>>(
  deserializer: D,
) -> Result<usize, D::Error> {
  let value = Value::deserialize(deserializer)?;
  // The standard ENV source supplies strings; parse without float coercion.
  if let Value::String(value) = &value {
    let concurrency = value.parse::<usize>().map_err(serde::de::Error::custom)?;
    validate_doc_decoder_concurrency(concurrency).map_err(serde::de::Error::custom)?;
    return Ok(concurrency);
  }
  doc_decoder_concurrency_from_value(&value).map_err(serde::de::Error::custom)
}

/// Ordered source layers that may contribute a registered setting.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EffectiveConfigSource {
  /// Bundled `default.yaml` baseline.
  Default,
  /// YAML selected by `RUN_MODE`.
  RunModeYaml,
  /// Package-local operator override.
  LocalYaml,
  /// Explicit writable runtime-overlay YAML.
  RuntimeOverlay,
  /// Canonical `MYOXUS__*` environment value.
  Environment,
  /// Value loaded from an allowlisted secret-file environment variable.
  SecretFile,
  /// Authoritative `app_configs` override.
  Database,
}

/// Whether the running process already uses the configured value.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeEffectiveState {
  /// The running process uses the configured value.
  Effective,
  /// The database value is durable but requires process restart to apply.
  PendingRestart,
}

/// JSON shape accepted for one canonical configuration path.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigValueType {
  Boolean,
  Number,
  String,
  Object,
  Array,
}

impl ConfigValueType {
  /// Stable, user-facing JSON type label used by transport-independent
  /// validation errors. Debug formatting is intentionally not an API contract.
  pub const fn label(self) -> &'static str {
    match self {
      Self::Boolean => "boolean",
      Self::Number => "number",
      Self::String => "string",
      Self::Object => "object",
      Self::Array => "array",
    }
  }
}

/// Persistence ownership for a registered setting.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigWritePolicy {
  /// The Admin/REST/CLI writer may persist a PostgreSQL override.
  DatabaseWritable,
  /// The value is owned by YAML, environment, or an allowlisted secret file.
  FileOnly,
}

/// Transport-independent contract for one exact configuration path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConfigDescriptor {
  /// Canonical PostgreSQL ID and exact boot-readable serde/YAML path.
  pub path: &'static str,
  /// JSON value shape accepted by all public writers.
  pub value_type: ConfigValueType,
  /// Durable source that is allowed to author the value.
  pub write_policy: ConfigWritePolicy,
  /// Whether external projections must redact the configured value.
  pub sensitive: bool,
  /// Whether a database override applies only after process restart.
  pub restart_required: bool,
  /// Whether Admin should apply a specialized live interaction immediately.
  pub immediate_apply: bool,
  /// Allowed string values; empty for non-enum settings.
  pub enum_values: &'static [&'static str],
  /// Inclusive lower bound for integer settings.
  pub min_value: Option<i64>,
  /// Inclusive upper bound for integer settings.
  pub max_value: Option<i64>,
  /// Optional allowlisted secret-file environment variable.
  pub secret_source: Option<&'static str>,
}

impl ConfigDescriptor {
  /// Returns whether Admin, REST and trusted CLI writers may persist the path.
  pub fn database_writable(&self) -> bool {
    self.write_policy == ConfigWritePolicy::DatabaseWritable
  }

  /// Splits the canonical path into its top-level module and remaining key.
  pub fn module_and_key(&self) -> (&'static str, &'static str) {
    self
      .path
      .split_once('.')
      .expect("descriptor paths contain a module and key")
  }

  /// Derives the canonical nested environment-variable name.
  pub fn environment_path(&self) -> String {
    format!(
      "MYOXUS__{}",
      self.path.replace('.', "__").replace('-', "_").to_ascii_uppercase()
    )
  }

  /// Returns whether the descriptor owns one complete object or array leaf.
  pub fn structured(&self) -> bool {
    matches!(self.value_type, ConfigValueType::Object | ConfigValueType::Array)
  }
}

const fn writable_number(
  path: &'static str,
  restart_required: bool,
  min_value: i64,
  max_value: i64,
) -> ConfigDescriptor {
  ConfigDescriptor {
    path,
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(min_value),
    max_value: Some(max_value),
    secret_source: None,
  }
}

/// Single canonical registry used by startup, runtime, API, Admin and CLI.
pub static CONFIG_REGISTRY: &[ConfigDescriptor] = &[
  ConfigDescriptor {
    path: "admin_i18n.default_locale",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.allow_signup",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.allow_signup_for_oauth",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.allowed_email_domains",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.dns_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.password_requirements",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.password_reset_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(300),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.reject_plus_aliases",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.require_email_domain_verification",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "auth.require_email_verification",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.doc_metadata_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(5),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.doc_metadata_projection_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(5),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.doc_snapshot_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(5),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.doc_timestamps_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(5),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.server_config_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.throttle_config_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.tuning_daily_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.tuning_hourly_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.user_features_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cache.ws_settings_fixed_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "calendar.caldav",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "calendar.google",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.algorithm",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["SHA-256", "SHA-384", "SHA-512"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.challenge_expires_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(60),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true, // middleware wiring + start-check
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.hmac_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.honeypot_field_name",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.max_number",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1_000),
    max_value: Some(10_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.rate_limit_per_account_per_hour",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "captcha.rate_limit_per_ip_per_min",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cleanup.history_retention_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cleanup.notification_retention_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cleanup.outbox_retention_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cleanup.pending_blob_retention_hours",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "client.clipboard_http_fallback",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "client.download_url",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "client.version_control.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "client.version_control.required_version",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.default_provider",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding_model",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding.api_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding.dimensions",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(16000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding.send_task_type",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding.endpoint",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.embedding.model",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.exa",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.fallback_providers",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.providers",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.request_timeout_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.storage_prefix",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "copilot.unsplash",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cors.allowed_custom_headers",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cors.allowed_origins",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cors.app_origins",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "cors.max_age_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "crypto.private_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: Some(super::runtime_config::CRYPTO_PRIVATE_KEY_FILE_ENV),
  },
  ConfigDescriptor {
    path: "database.url",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: Some(super::runtime_config::DATABASE_URL_FILE_ENV),
  },
  ConfigDescriptor {
    path: "databases.csv_max_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.csv_max_columns",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.csv_max_rows",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.csv_sample_rows_for_type_inference",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_cell_text_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_fields_per_database",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_reminder_offset_minutes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: Some(5_256_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_reminders_per_user_per_cell",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(20),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_rows_per_page",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.max_views_per_database",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "databases.reminder_batch_size",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(1_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "doc_service.endpoint",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "doc.history.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "doc.history.interval",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(900_000),
    max_value: Some(86_400_000),
    secret_source: None,
  },
  writable_number("doc.decoder_concurrency", true, 1, MAX_DOC_DECODER_CONCURRENCY as i64),
  ConfigDescriptor {
    path: "document_graph.enqueue_delay_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_catch_up_workspaces",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_graph_edges",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_graph_nodes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_occurrences_per_edge",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_reindex_attempts",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.max_reindex_batch",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.preview_max_chars",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_graph.stale_after_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_versioning.default_auto_version_on_pdf_export",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_versioning.default_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "document_versioning.default_retention_count",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "flags.allow_guest_demo_workspace",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.allowed_auth_methods",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.allowed_directions",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.allowed_hosts",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.auto_sync_allowed",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.clone_depth",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.commit_author_email",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.commit_author_name",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.default_branch",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.https_ca_bundle_path",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "tls.additional_ca_bundle_path",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.https_certificate_policy",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["strict", "insecure_no_verify"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.local_timeout_secs",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.lock_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(3600),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.max_docs_per_sync",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.max_mirror_storage_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.mime_allowlist_admin",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.mime_blocklist_admin",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.mime_validation_mode",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["strict", "warn"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.min_free_disk_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.network_timeout_secs",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.parallel_conversion_threshold",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.push_max_retries",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.retention_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(30),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.repo_base_dir",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.ssh_host_key_policy",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["accept_new", "strict", "insecure_no_verify"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "git_sync.webhook_allowed",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "http.proxy_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "i18n.available_locales",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "i18n.default_currency",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["EUR", "USD", "GBP", "CHF", "CAD", "AUD", "JPY"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "i18n.default_locale",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.auto_index_batch_size",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.provider_api_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.provider_endpoint",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.provider_password",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.provider_type",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "indexer.provider_username",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queue",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.caldav-sync",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.calendar-reminder",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.copilot",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.database",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.doc",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.document-graph",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.git-sync",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.google-calendar-sync",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.indexer",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.nightly",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.notification",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.pdf-export",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.template-registry",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.workspace-automation",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.queues.workspace-content-operation",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "job.worker",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "journal.calendar_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "journal.first_day_of_week",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["monday", "sunday"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "journal.show_calendar_weeks",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "logging.file_path",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "logging.level",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "logging.max_files",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "logging.max_history",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "logging.rotation",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["never", "hourly", "daily", "weekly"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_domains",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.host",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.name",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.password",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.port",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.sender",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.transport",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["plain", "starttls", "implicit_tls"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.username",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.fallback_smtp.verify_certificate",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.sender",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_host",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_name",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_pass",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_port",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_transport",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["plain", "starttls", "implicit_tls"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_user",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mail.smtp_verify_certificate",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "mcp.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.cardinality_limit_per_metric",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.categories",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.flush_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.label_workspace_id_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.persistence_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.prometheus_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.retention_daily_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "metrics.retention_raw_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "oauth.providers.apple",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "oauth.providers.github",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "oauth.providers.google",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "oauth.providers.oidc",
    value_type: ConfigValueType::Object,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.body_font_scale",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.default_color_profile",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["sRGB", "CMYK_FOGRA39", "CMYK_SWOP"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.default_image_quality",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["low", "med", "high", "lossless"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.default_paper_size",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["A4", "Letter", "A3", "A5"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.edgeless_snapshot.max_dim_px",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(512),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.edgeless_snapshot.max_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.edgeless_snapshot.max_total_px",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(262_144),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.heading_font_scale",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.limits.max_concurrent_per_workspace",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.limits.max_input_blocks",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.limits.max_memory_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(64),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.limits.max_pages",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.limits.render_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.max_brand_asset_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.max_dpi",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(72),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.max_font_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.max_template_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.sync_threshold_blocks",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.verapdf_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "pdf_export.verapdf_validator_url",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  writable_number("preview.failure_expiry_seconds", true, 1, 3_600),
  writable_number("preview.max_active_global_renders", true, 1, 1_024),
  writable_number("preview.max_active_renders_per_actor", true, 1, 1_024),
  writable_number("preview.max_decoded_image_pixels", false, 1, 268_435_456),
  writable_number("preview.max_depth", false, 1, 256),
  writable_number("preview.max_font_bytes", false, 1, 1_073_741_824),
  writable_number("preview.max_in_flight_requests", true, 1, 4_096),
  writable_number("preview.max_input_bytes", false, 1, 1_073_741_824),
  writable_number("preview.max_media_bytes", false, 1, 1_073_741_824),
  writable_number("preview.max_mermaid_elements", false, 1, 100_000),
  writable_number("preview.max_mermaid_source_bytes", false, 1, 262_144),
  writable_number("preview.max_outlined_paths", false, 1, 1_000_000),
  writable_number("preview.max_output_svg_bytes", false, 1, 268_435_456),
  writable_number("preview.max_png_pixels", false, 1, 268_435_456),
  writable_number("preview.max_projected_blocks", false, 1, 100_000),
  writable_number("preview.max_source_blocks", false, 1, 1_000_000),
  writable_number("preview.max_svg_input_bytes", false, 1, 268_435_456),
  writable_number("preview.max_table_columns", false, 1, 1_000),
  writable_number("preview.max_table_rows", false, 1, 10_000),
  writable_number("preview.max_text_chars", false, 1, 10_000_000),
  writable_number("preview.max_visuals", false, 1, 100),
  writable_number("preview.output_cache_max_bytes", true, 1, 4_294_967_296),
  writable_number("preview.output_cache_max_entries", true, 1, 1_000_000),
  writable_number("preview.output_cache_ttl_seconds", true, 1, 86_400),
  writable_number("preview.prepared_font_cache_max_bytes", true, 1, 4_294_967_296),
  writable_number("preview.prepared_font_cache_max_entries", true, 1, 10_000),
  writable_number("preview.prepared_font_cache_ttl_seconds", true, 1, 86_400),
  writable_number("preview.render_timeout_ms", false, 1, 300_000),
  writable_number("preview.request_timeout_ms", false, 1, 300_000),
  writable_number("preview.retry_count", false, 0, 10),
  ConfigDescriptor {
    path: "redis.cache_ttl_doc_metadata_projection_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_doc_metadata_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_doc_snapshot_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_doc_timestamps_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_document_metadata_index_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_git_status_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_quota_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.cache_ttl_usage_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.compaction_lock_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.compaction_lock_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(10),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.compaction_threshold_default",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(10),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.compaction_threshold_root_doc",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_metadata_cache_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_metadata_projection_cache_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_snapshot_cache_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_snapshot_cache_max_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_timestamps_cache_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_timestamps_cache_max_docs",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.doc_view_dedup_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.document_metadata_index_cache_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.document_metadata_index_cache_max_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "redis.url",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.deployment_type",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["standalone", "cloud"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.host",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.magic_link_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.name",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.origin",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.port",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.session_ttl",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "server.session_ttr",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.access_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.backend",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &["local", "s3", "r2"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.bucket",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.default_workspace_quota_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.endpoint",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.io_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.max_upload_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.min_free_space_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(0),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.multipart_threshold_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.prefix",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.region",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.root",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::FileOnly,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.secret_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "storage.signed_url_ttl_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.allowed_origins",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.batch_max_events",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.categories",
    value_type: ConfigValueType::Object, // HashMap<category, bool>
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.dedupe_max_entries",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.dedupe_ttl_hours",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true, // ingest wiring + worker scheduler
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.flush_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true, // cron tick is registered once at startup
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.ingest_rate_limit_per_ip_per_min",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.retention_daily_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.retention_raw_days",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "telemetry.sampling_rates",
    value_type: ConfigValueType::Object, // HashMap<category, f32>
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.builtin_bridge_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.drift_scan_enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.drift_scan_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.import_max_bundle_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "template_registry.reconcile_default_mode",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &["seed_once", "managed_until_local_edit", "manual_update"],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "templates.root_dir",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "throttle.throttlers.default.limit",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "throttle.throttlers.default.ttl_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "throttle.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "throttle.throttlers.strict.limit",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "throttle.throttlers.strict.ttl_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.api_key",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: true,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: Some("MYOXUS__TRANSCRIPTION__API_KEY_FILE"),
  },
  ConfigDescriptor {
    path: "transcription.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.endpoint",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.language",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.max_concurrency",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(64),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.max_duration_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(86400),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.max_input_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(1073741824),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.max_response_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1024),
    max_value: Some(67108864),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.model",
    value_type: ConfigValueType::String,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "transcription.request_timeout_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(100),
    max_value: Some(600000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.broadcast_channel_capacity",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.max_http_buffer_size_mb",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(1024),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.max_connections_per_second_per_client",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(100),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.eio_ping_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(2_147_483),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.eio_ping_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(2_147_483),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.ping_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "websocket.transports",
    value_type: ConfigValueType::Array,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.cron_tick_interval_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.calendar_reminder_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.database_projection_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(5000),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.database_reminder_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1_000),
    max_value: Some(3_600_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.doc_maintenance_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.document_graph_reindex_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(5000),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.indexer_auto_index_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "worker.polling.workspace_automation_retry_interval_ms",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(5000),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace_automation.enabled",
    value_type: ConfigValueType::Boolean,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: None,
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace_automation.max_actions_per_run",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace_automation.max_retry_attempts",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace_automation.max_runs_per_minute",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace_automation.webhook_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: None,
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.job_timeout_seconds",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(60),
    max_value: Some(86_400),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_archive_entries",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(1_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_asset_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1_048_576),
    max_value: Some(107_374_182_400),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_assets",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(2_500_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_blocks",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(50_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_cells_per_database",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(200_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_compression_ratio",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(10_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_databases",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(100_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_documents",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(1_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_entry_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1_048_576),
    max_value: Some(10_737_418_240),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_expanded_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1_048_576),
    max_value: Some(107_374_182_400),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_rows_per_database",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(10_000_000),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_sqlite_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1_048_576),
    max_value: Some(10_737_418_240),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.max_upload_bytes",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1_048_576),
    max_value: Some(10_737_418_240),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.staging_retention_hours",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: false,
    immediate_apply: true,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(720),
    secret_source: None,
  },
  ConfigDescriptor {
    path: "workspace.import.worker_concurrency",
    value_type: ConfigValueType::Number,
    write_policy: ConfigWritePolicy::DatabaseWritable,
    sensitive: false,
    restart_required: true,
    immediate_apply: false,
    enum_values: &[],
    min_value: Some(1),
    max_value: Some(64),
    secret_source: None,
  },
];

/// Finds the descriptor for one exact canonical path.
pub fn find_descriptor(path: &str) -> Option<&'static ConfigDescriptor> {
  CONFIG_REGISTRY.iter().find(|descriptor| descriptor.path == path)
}

/// Finds a descriptor from transport-level module and key components.
pub fn find_descriptor_parts(module: &str, key: &str) -> Option<&'static ConfigDescriptor> {
  let path = format!("{module}.{key}");
  find_descriptor(&path)
}

/// Iterates descriptors owned by one exact top-level module.
pub fn descriptors_by_module(module: &str) -> impl Iterator<Item = &'static ConfigDescriptor> {
  CONFIG_REGISTRY.iter().filter(move |descriptor| {
    descriptor.path.starts_with(module) && descriptor.path.as_bytes().get(module.len()) == Some(&b'.')
  })
}

/// Returns the registry cardinality for contract and diagnostic checks.
pub fn descriptor_count() -> usize {
  CONFIG_REGISTRY.len()
}

/// Central sensitivity decision used by API, Admin, and CLI projections.
pub fn is_sensitive_config_key(path: &str) -> bool {
  find_descriptor(path).is_some_and(|descriptor| descriptor.sensitive)
}

/// Registered values whose typed `AppConfig` field deliberately accepts JSON
/// `null`. This is distinct from removing a database override.
pub fn is_nullable_config_path(path: &str) -> bool {
  matches!(
    path,
    "calendar.caldav"
      | "calendar.google"
      | "cache.server_config_fixed_ttl_seconds"
      | "cache.user_features_fixed_ttl_seconds"
      | "cache.throttle_config_fixed_ttl_seconds"
      | "cache.ws_settings_fixed_ttl_seconds"
      | "cache.doc_snapshot_fixed_ttl_seconds"
      | "cache.doc_metadata_fixed_ttl_seconds"
      | "cache.doc_metadata_projection_fixed_ttl_seconds"
      | "cache.doc_timestamps_fixed_ttl_seconds"
      | "transcription.api_key"
      | "transcription.language"
      | "copilot.embedding.api_key"
      | "copilot.embedding.endpoint"
      | "doc_service.endpoint"
      | "git_sync.https_ca_bundle_path"
      | "tls.additional_ca_bundle_path"
      | "indexer.provider_api_key"
      | "indexer.provider_endpoint"
      | "indexer.provider_password"
      | "indexer.provider_type"
      | "indexer.provider_username"
      | "mail.fallback_smtp.name"
      | "mail.smtp_user"
      | "mail.smtp_pass"
      | "mail.smtp_host"
      | "mail.smtp_name"
      | "mail.fallback_smtp.username"
      | "mail.fallback_smtp.password"
      | "storage.access_key"
      | "storage.bucket"
      | "storage.endpoint"
      | "storage.prefix"
      | "storage.region"
      | "storage.root"
      | "storage.secret_key"
      | "logging.file_path"
      | "pdf_export.verapdf_validator_url"
  )
}

/// One non-sensitive observation in the source-precedence chain.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConfigSourceObservation {
  /// Layer that provided the observed path.
  pub source: EffectiveConfigSource,
  /// Canonical environment name, safe file label or registry path.
  pub source_key: String,
}

/// Sanitized startup values and provenance used by external projections.
///
/// Sensitive values are never retained in this snapshot. Runtime consumers
/// use typed `AppConfig` and `ConfigOverrides` instead.
#[derive(Clone, Debug, Default)]
pub struct ConfigSourceSnapshot {
  effective_values: BTreeMap<String, Value>,
  observations: BTreeMap<String, Vec<ConfigSourceObservation>>,
}

impl ConfigSourceSnapshot {
  /// Preserve the actual legacy file/ENV source when normalizing a deployed key.
  pub fn record_alias(&mut self, from: &str, to: &str, value: Value) {
    self.effective_values.insert(to.to_string(), value);
    if let Some(observations) = self.observations.get(from).cloned() {
      self.observations.insert(to.to_string(), observations);
    }
  }
  /// Builds a sanitized snapshot from the fully layered startup value tree.
  pub fn from_resolved_values(resolved: &Value) -> Self {
    let mut effective_values = BTreeMap::new();
    flatten_json("", resolved, &mut effective_values);
    for (path, value) in &mut effective_values {
      if is_sensitive_config_key(path) && !value.is_null() {
        *value = Value::String(MASKED_CONFIG_VALUE.to_string());
      }
    }
    Self {
      effective_values,
      observations: BTreeMap::new(),
    }
  }

  /// Records all registered paths observed in one non-secret source layer.
  pub fn record_layer(&mut self, source: EffectiveConfigSource, source_key: &str, values: &Value) {
    let mut flattened = BTreeMap::new();
    flatten_json("", values, &mut flattened);
    for path in flattened.keys() {
      self
        .observations
        .entry(path.clone())
        .or_default()
        .push(ConfigSourceObservation {
          source,
          source_key: source_key.to_string(),
        });
    }
  }

  /// Records one source whose raw value must not be retained in provenance.
  pub fn record_explicit(&mut self, path: &str, source: EffectiveConfigSource, source_key: &str) {
    self
      .observations
      .entry(path.to_string())
      .or_default()
      .push(ConfigSourceObservation {
        source,
        source_key: source_key.to_string(),
      });
  }

  /// Resolves one externally safe value and its lifecycle/source metadata.
  pub fn resolve(
    &self,
    descriptor: &ConfigDescriptor,
    database_overrides: &HashMap<String, Value>,
  ) -> Result<EffectiveConfigField, EffectiveConfigError> {
    let mut runtime_value = self.effective_values.get(descriptor.path).cloned();
    let mut configured_value = runtime_value.clone();
    let mut observations = self.observations.get(descriptor.path).cloned().unwrap_or_default();
    let database_value = database_overrides.get(descriptor.path);
    if !descriptor.database_writable() && descriptor.path != "git_sync.https_ca_bundle_path" && database_value.is_some()
    {
      return Err(EffectiveConfigError::DatabaseWriteForbidden(
        descriptor.path.to_string(),
      ));
    }
    if let Some(value) = database_value {
      configured_value = Some(mask_if_sensitive(descriptor, value.clone()));
      observations.push(ConfigSourceObservation {
        source: EffectiveConfigSource::Database,
        source_key: descriptor.path.to_string(),
      });
      if !descriptor.restart_required {
        runtime_value = configured_value.clone();
      }
    }

    let runtime_effective_state = if descriptor.restart_required
      && configured_value.is_some()
      && configured_value != runtime_value
      && database_value.is_some()
    {
      RuntimeEffectiveState::PendingRestart
    } else {
      RuntimeEffectiveState::Effective
    };
    let winning = observations.last().cloned();
    let overridden_sources = observations
      .iter()
      .take(observations.len().saturating_sub(1))
      .cloned()
      .collect();

    Ok(EffectiveConfigField {
      path: descriptor.path.to_string(),
      configured_value,
      runtime_effective_value: runtime_value,
      is_set: winning.is_some(),
      winning_source: winning.as_ref().map(|entry| entry.source),
      winning_key: winning.map(|entry| entry.source_key),
      overridden_sources,
      runtime_effective_state,
      restart_required: descriptor.restart_required,
      sensitive: descriptor.sensitive,
    })
  }

  /// Returns sanitized startup values keyed by canonical descriptor path.
  pub fn resolved_values(&self) -> &BTreeMap<String, Value> {
    &self.effective_values
  }
}

/// Externally safe effective value and provenance for one descriptor.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EffectiveConfigField {
  /// Exact canonical registry path.
  pub path: String,
  /// Highest-precedence configured value, redacted when sensitive.
  pub configured_value: Option<Value>,
  /// Value used by the current process, redacted when sensitive.
  pub runtime_effective_value: Option<Value>,
  /// Whether any source explicitly supplied the path.
  pub is_set: bool,
  /// Highest-precedence source, if configured.
  pub winning_source: Option<EffectiveConfigSource>,
  /// Safe source identifier for the winning observation.
  pub winning_key: Option<String>,
  /// Lower-precedence sources shadowed by the winning observation.
  pub overridden_sources: Vec<ConfigSourceObservation>,
  /// Whether the configured value is already active.
  pub runtime_effective_state: RuntimeEffectiveState,
  /// Registry lifecycle flag exposed to operators.
  pub restart_required: bool,
  /// Registry sensitivity flag exposed without revealing the value.
  pub sensitive: bool,
}

/// Effective-projection failure caused by an invalid source ownership state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectiveConfigError {
  /// A file-owned descriptor was found in the database override map.
  DatabaseWriteForbidden(String),
}

impl std::fmt::Display for EffectiveConfigError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::DatabaseWriteForbidden(path) => {
        write!(
          formatter,
          "{path} is configured through YAML, environment, or a secret file only"
        )
      }
    }
  }
}

impl std::error::Error for EffectiveConfigError {}

fn mask_if_sensitive(descriptor: &ConfigDescriptor, value: Value) -> Value {
  if descriptor.sensitive && !value.is_null() {
    Value::String(MASKED_CONFIG_VALUE.to_string())
  } else {
    value
  }
}

fn flatten_json(prefix: &str, value: &Value, output: &mut BTreeMap<String, Value>) {
  if !prefix.is_empty() && find_descriptor(prefix).is_some_and(ConfigDescriptor::structured) {
    output.insert(prefix.to_string(), value.clone());
  } else if let Value::Object(map) = value {
    for (key, value) in map {
      let path = if prefix.is_empty() {
        key.clone()
      } else {
        format!("{prefix}.{key}")
      };
      flatten_json(&path, value, output);
    }
  } else if !prefix.is_empty() {
    output.insert(prefix.to_string(), value.clone());
  }
}

/// Validate invariants that span multiple canonical configuration paths.
///
/// Callers must pass the complete effective candidate, including file/default
/// baselines and pending database mutations. This keeps CLI, REST and GraphQL
/// writes from accepting a state that another transport would reject.
pub fn validate_config_candidate(values: &BTreeMap<String, Value>) -> Result<(), String> {
  if let Some(providers) = values.get("copilot.providers") {
    crate::copilot::validate_model_options(providers)?;
  }
  if values
    .get("templates.root_dir")
    .is_some_and(|value| value.as_str().is_none_or(|root| root.trim().is_empty()))
  {
    return Err("templates.root_dir must be a non-empty path".into());
  }
  if let Some(value) = values.get("doc.decoder_concurrency") {
    doc_decoder_concurrency_from_value(value).map_err(str::to_string)?;
  }
  if values.get("transcription.enabled").and_then(Value::as_bool) == Some(true) {
    for path in ["transcription.endpoint", "transcription.model"] {
      if values
        .get(path)
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
      {
        return Err(format!("{path} is required when transcription is enabled"));
      }
    }
  }
  for descriptor in CONFIG_REGISTRY
    .iter()
    .filter(|field| field.path.starts_with("transcription."))
  {
    if descriptor.value_type == ConfigValueType::Number
      && let Some(value) = values.get(descriptor.path)
    {
      let number = value
        .as_i64()
        .ok_or_else(|| format!("{} must be an integer", descriptor.path))?;
      if descriptor.min_value.is_some_and(|min| number < min) || descriptor.max_value.is_some_and(|max| number > max) {
        return Err(format!("{} is outside its allowed bounds", descriptor.path));
      }
    }
  }
  // engine.io-client passes the advertised millisecond sum to setTimeout.
  // Its signed 32-bit timer boundary must not wrap into an immediate timeout.
  let mut heartbeat_seconds = 0_u64;
  for path in [
    "websocket.eio_ping_interval_seconds",
    "websocket.eio_ping_timeout_seconds",
  ] {
    if let Some(value) = values.get(path) {
      let seconds = value
        .as_u64()
        .filter(|seconds| *seconds > 0)
        .ok_or_else(|| format!("{path} must be positive integral seconds"))?;
      heartbeat_seconds = heartbeat_seconds
        .checked_add(seconds)
        .ok_or_else(|| "Engine.IO heartbeat sum overflows".to_string())?;
    }
  }
  if heartbeat_seconds
    .checked_mul(1000)
    .is_none_or(|millis| millis > i32::MAX as u64)
  {
    return Err("Engine.IO heartbeat interval plus timeout exceeds the client timer limit".to_string());
  }
  let number = |path: &str| values.get(path).and_then(Value::as_u64);
  if let (Some(entry), Some(expanded)) = (
    number("workspace.import.max_entry_bytes"),
    number("workspace.import.max_expanded_bytes"),
  ) && entry > expanded
  {
    return Err("workspace.import.max_entry_bytes must not exceed max_expanded_bytes".to_string());
  }
  if let (Some(sqlite), Some(upload)) = (
    number("workspace.import.max_sqlite_bytes"),
    number("workspace.import.max_upload_bytes"),
  ) && sqlite > upload
  {
    return Err("workspace.import.max_sqlite_bytes must not exceed max_upload_bytes".to_string());
  }
  if let (Some(assets), Some(expanded)) = (
    number("workspace.import.max_asset_bytes"),
    number("workspace.import.max_expanded_bytes"),
  ) && assets > expanded
  {
    return Err("workspace.import.max_asset_bytes must not exceed max_expanded_bytes".to_string());
  }

  for (smaller, larger) in [
    ("preview.max_projected_blocks", "preview.max_source_blocks"),
    ("preview.max_svg_input_bytes", "preview.max_media_bytes"),
    ("preview.max_output_svg_bytes", "preview.output_cache_max_bytes"),
    ("preview.max_font_bytes", "preview.prepared_font_cache_max_bytes"),
    (
      "preview.max_active_renders_per_actor",
      "preview.max_active_global_renders",
    ),
    ("preview.max_active_global_renders", "preview.max_in_flight_requests"),
    ("preview.render_timeout_ms", "preview.request_timeout_ms"),
  ] {
    if let (Some(smaller_value), Some(larger_value)) = (number(smaller), number(larger))
      && smaller_value > larger_value
    {
      return Err(format!("{smaller} must not exceed {larger}"));
    }
  }

  if values.get("git_sync.https_certificate_policy").and_then(Value::as_str) == Some("insecure_no_verify") {
    let has_allowed_host = values
      .get("git_sync.allowed_hosts")
      .and_then(Value::as_array)
      .is_some_and(|hosts| {
        hosts
          .iter()
          .filter_map(Value::as_str)
          .any(|host| !host.trim().is_empty())
      });
    if !has_allowed_host {
      return Err(
        "git_sync.https_certificate_policy insecure_no_verify requires at least one explicit git_sync.allowed_hosts entry"
          .to_string(),
      );
    }
  }

  for (username_path, password_path) in [
    ("mail.smtp_user", "mail.smtp_pass"),
    ("mail.fallback_smtp.username", "mail.fallback_smtp.password"),
  ] {
    let is_set = |path: &str| {
      values
        .get(path)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    };
    if is_set(username_path) != is_set(password_path) {
      return Err(format!(
        "{username_path} and {password_path} must both be configured or both be empty"
      ));
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::collections::{HashMap, HashSet};

  use super::*;

  #[test]
  fn decoder_capacity_uses_restart_only_integer_configuration() {
    let descriptor = find_descriptor("doc.decoder_concurrency").expect("registered decoder capacity");
    assert!(descriptor.database_writable());
    assert!(descriptor.restart_required);
    assert!(!descriptor.immediate_apply);
    assert_eq!(descriptor.environment_path(), "MYOXUS__DOC__DECODER_CONCURRENCY");
    for value in [1, 8, 16, 32, MAX_DOC_DECODER_CONCURRENCY] {
      let candidate = BTreeMap::from([(descriptor.path.to_string(), serde_json::json!(value))]);
      validate_config_candidate(&candidate).expect("representable positive decoder capacity");
    }
    for value in [
      serde_json::json!(0),
      serde_json::json!(-1),
      serde_json::json!(1.5),
      serde_json::json!(MAX_DOC_DECODER_CONCURRENCY + 1),
      serde_json::json!(u64::MAX),
      serde_json::json!("16"),
    ] {
      let candidate = BTreeMap::from([(descriptor.path.to_string(), value)]);
      assert!(validate_config_candidate(&candidate).is_err());
    }
  }

  #[test]
  fn registry_paths_are_unique_and_structured_values_are_leaf_descriptors() {
    let mut paths = HashSet::new();
    for descriptor in CONFIG_REGISTRY {
      assert!(
        paths.insert(descriptor.path),
        "duplicate descriptor {}",
        descriptor.path
      );
      assert!(
        descriptor.path.split_once('.').is_some(),
        "invalid descriptor {}",
        descriptor.path
      );
      if descriptor.structured() {
        let child_prefix = format!("{}.", descriptor.path);
        assert!(
          !CONFIG_REGISTRY
            .iter()
            .any(|candidate| candidate.path.starts_with(&child_prefix)),
          "structured descriptor {} has a child descriptor",
          descriptor.path
        );
      }
    }
  }

  #[test]
  fn representative_lifecycle_and_write_policies_remain_distinct() {
    let restart = find_descriptor("server.origin").expect("server origin descriptor");
    assert!(restart.database_writable());
    assert!(restart.restart_required);
    assert!(!restart.immediate_apply);

    let live_auto = find_descriptor("git_sync.enabled").expect("Git Sync descriptor");
    assert!(live_auto.database_writable());
    assert!(!live_auto.restart_required);
    assert!(live_auto.immediate_apply);

    let live_explicit = find_descriptor("logging.level").expect("logging descriptor");
    assert!(live_explicit.database_writable());
    assert!(!live_explicit.restart_required);
    assert!(!live_explicit.immediate_apply);

    let file_only = find_descriptor("crypto.private_key").expect("private key descriptor");
    assert!(!file_only.database_writable());
    assert!(file_only.sensitive);
    assert_eq!(
      file_only.secret_source,
      Some(super::super::runtime_config::CRYPTO_PRIVATE_KEY_FILE_ENV)
    );
  }

  #[test]
  fn effective_projection_uses_one_exact_path_and_masks_secrets() {
    let mut snapshot = ConfigSourceSnapshot::from_resolved_values(&serde_json::json!({
      "server": {"origin": "https://file.example"},
      "mail": {"smtp_pass": "file-secret"}
    }));
    snapshot.record_layer(
      EffectiveConfigSource::Default,
      "default.yaml",
      &serde_json::json!({"server": {"origin": "https://file.example"}}),
    );
    let origin = find_descriptor("server.origin").expect("origin descriptor");
    let field = snapshot
      .resolve(
        origin,
        &HashMap::from([("server.origin".to_string(), serde_json::json!("https://db.example"))]),
      )
      .expect("effective origin");
    assert_eq!(field.path, "server.origin");
    assert_eq!(field.winning_source, Some(EffectiveConfigSource::Database));
    assert_eq!(field.runtime_effective_state, RuntimeEffectiveState::PendingRestart);

    assert!(
      snapshot
        .resolved_values()
        .values()
        .all(|value| !value.to_string().contains("file-secret"))
    );
  }

  #[test]
  fn registered_structured_values_flatten_to_one_database_row() {
    let snapshot = ConfigSourceSnapshot::from_resolved_values(&serde_json::json!({
      "oauth": {
        "providers": {
          "oidc": {"clientId": "client", "scopes": ["openid"]}
        }
      }
    }));
    assert_eq!(
      snapshot.resolved_values().get("oauth.providers.oidc"),
      Some(&serde_json::json!(MASKED_CONFIG_VALUE))
    );
    assert!(!snapshot.resolved_values().contains_key("oauth.providers.oidc.clientId"));
  }

  #[test]
  fn candidate_validation_rejects_cross_field_configuration_drift() {
    let mut values = BTreeMap::from([
      (
        "git_sync.https_certificate_policy".to_string(),
        serde_json::json!("strict"),
      ),
      ("git_sync.allowed_hosts".to_string(), serde_json::json!([])),
      ("mail.smtp_user".to_string(), serde_json::json!("")),
      ("mail.smtp_pass".to_string(), serde_json::json!("")),
      ("workspace.import.max_entry_bytes".to_string(), serde_json::json!(2)),
      ("workspace.import.max_expanded_bytes".to_string(), serde_json::json!(4)),
    ]);
    validate_config_candidate(&values).expect("valid candidate");

    values.insert(
      "git_sync.https_certificate_policy".to_string(),
      serde_json::json!("insecure_no_verify"),
    );
    assert!(validate_config_candidate(&values).is_err());
    values.insert(
      "git_sync.https_certificate_policy".to_string(),
      serde_json::json!("strict"),
    );
    values.insert("mail.smtp_user".to_string(), serde_json::json!("user"));
    assert!(validate_config_candidate(&values).is_err());
  }

  #[test]
  fn copilot_model_controls_validate_literal_keys_and_explicit_states() {
    let provider = |options: Value| serde_json::json!({"local":{"models":["model.v1/path"],"model_options":options}});
    for control in [
      serde_json::json!({"type":"enable_thinking"}),
      serde_json::json!({"type":"reasoning_effort","on":"high","off":"none"}),
    ] {
      let values = BTreeMap::from([(
        "copilot.providers".into(),
        provider(serde_json::json!({"model.v1/path":{"reasoning_control":control}})),
      )]);
      validate_config_candidate(&values).unwrap();
    }
    for options in [
      serde_json::json!({"missing":{"reasoning_control":{"type":"enable_thinking"}}}),
      serde_json::json!({"model.v1/path":{"reasoning_control":{"type":"reasoning_effort","on":"high","off":"high"}}}),
      serde_json::json!({"model.v1/path":{"reasoning_control":{"type":"reasoning_effort","on":"unsupported","off":"none"}}}),
      serde_json::json!({"model.v1/path":{"reasoning_control":{"type":"reasoning_effort","on":"high"}}}),
      serde_json::json!({"model.v1/path":{"reasoning_control":{"type":"unknown"}}}),
    ] {
      assert!(validate_config_candidate(&BTreeMap::from([("copilot.providers".into(), provider(options))])).is_err());
    }
    validate_config_candidate(&BTreeMap::from([(
      "copilot.providers".into(),
      serde_json::json!({"local":{"models":["model.v1/path"]}}),
    )]))
    .unwrap();
    for path in [
      "copilot.providers",
      "copilot.default_provider",
      "copilot.fallback_providers",
      "copilot.request_timeout_ms",
    ] {
      assert!(
        CONFIG_REGISTRY
          .iter()
          .find(|descriptor| descriptor.path == path)
          .unwrap()
          .restart_required
      );
    }
  }

  #[test]
  fn preview_candidate_validation_rejects_incoherent_resource_budgets() {
    let valid = BTreeMap::from([
      ("preview.max_source_blocks".to_string(), serde_json::json!(100)),
      ("preview.max_projected_blocks".to_string(), serde_json::json!(30)),
      ("preview.max_media_bytes".to_string(), serde_json::json!(4_194_304)),
      ("preview.max_svg_input_bytes".to_string(), serde_json::json!(2_097_152)),
      (
        "preview.output_cache_max_bytes".to_string(),
        serde_json::json!(8_388_608),
      ),
      ("preview.max_output_svg_bytes".to_string(), serde_json::json!(4_194_304)),
      (
        "preview.prepared_font_cache_max_bytes".to_string(),
        serde_json::json!(67_108_864),
      ),
      ("preview.max_font_bytes".to_string(), serde_json::json!(33_554_432)),
      ("preview.max_active_renders_per_actor".to_string(), serde_json::json!(2)),
      ("preview.max_active_global_renders".to_string(), serde_json::json!(8)),
      ("preview.max_in_flight_requests".to_string(), serde_json::json!(32)),
      ("preview.render_timeout_ms".to_string(), serde_json::json!(3_000)),
      ("preview.request_timeout_ms".to_string(), serde_json::json!(5_000)),
    ]);
    validate_config_candidate(&valid).expect("coherent preview budgets");
    for (smaller, larger) in [
      ("preview.max_projected_blocks", "preview.max_source_blocks"),
      ("preview.max_svg_input_bytes", "preview.max_media_bytes"),
      (
        "preview.max_active_renders_per_actor",
        "preview.max_active_global_renders",
      ),
      ("preview.max_active_global_renders", "preview.max_in_flight_requests"),
      ("preview.render_timeout_ms", "preview.request_timeout_ms"),
    ] {
      let mut invalid = valid.clone();
      invalid.insert(smaller.to_string(), serde_json::json!(101));
      invalid.insert(larger.to_string(), serde_json::json!(100));
      assert!(
        validate_config_candidate(&invalid).is_err(),
        "{smaller} must not exceed {larger}"
      );
    }
  }
}
