// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared live-configuration refresh for canonical `app_configs` overrides.
//!
//! Startup, local writes, Redis invalidation and the bounded recovery poll all
//! call the same refresh path. Only descriptors marked as live are projected
//! into [`ConfigOverrides`]; restart-bound values remain in the startup
//! [`AppConfig`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{debug, instrument, warn};

use crate::config::{AppConfig, PreviewConfig};
use myoxus_contracts::effective_config::CONFIG_REGISTRY;

/// Password-policy provider backed by the universal live configuration
/// snapshot. This keeps password validation coherent with Admin changes
/// without introducing a service-specific SQL reader or refresh loop.
#[derive(Clone)]
pub struct RuntimePasswordPolicyProvider {
  fallback: crate::config::PasswordRequirementsConfig,
  overrides: Arc<RwLock<ConfigOverrides>>,
}

impl RuntimePasswordPolicyProvider {
  /// Creates a provider with an immutable file baseline and the shared live
  /// override snapshot used by every other runtime configuration consumer.
  pub fn new(fallback: crate::config::PasswordRequirementsConfig, overrides: Arc<RwLock<ConfigOverrides>>) -> Self {
    Self { fallback, overrides }
  }
}

#[async_trait::async_trait]
impl myoxus_application::auth::PasswordPolicyProvider for RuntimePasswordPolicyProvider {
  async fn current_policy(&self) -> myoxus_application::auth::AuthResult<myoxus_application::auth::PasswordPolicy> {
    let overrides = self.overrides.read().await;
    let value = overrides.overrides.get("auth.password_requirements");
    let min = value
      .and_then(|value| value.get("min"))
      .and_then(serde_json::Value::as_u64)
      .and_then(|value| usize::try_from(value).ok())
      .unwrap_or(self.fallback.min);
    let max = value
      .and_then(|value| value.get("max"))
      .and_then(serde_json::Value::as_u64)
      .and_then(|value| usize::try_from(value).ok())
      .unwrap_or(self.fallback.max);
    myoxus_application::auth::PasswordPolicy::new(min, max)
  }
}

pub(crate) fn resolve_websocket_connection_admission_limit(
  startup_value: u32,
  overrides: &HashMap<String, serde_json::Value>,
) -> u32 {
  overrides
    .get("websocket.max_connections_per_second_per_client")
    .and_then(serde_json::Value::as_u64)
    .and_then(|value| u32::try_from(value).ok())
    .filter(|value| (1..=100).contains(value))
    .unwrap_or(startup_value)
}

/// Recovery-poll interval for missed cross-instance invalidations.
///
/// Local writes refresh immediately and Redis wakes other instances. This
/// bounded poll is the convergence fallback, not the normal apply latency.
pub const DEFAULT_RELOAD_INTERVAL: Duration = Duration::from_secs(30);

/// Live effective values and the time at which they were materialized.
///
/// The map contains every non-restart descriptor resolved from the current
/// database override or immutable file/ENV baseline. It deliberately excludes
/// restart-bound rows even when they are present in `app_configs`.
#[derive(Clone, Debug)]
pub struct ConfigOverrides {
  /// Effective JSON value for every registered live descriptor.
  pub overrides: HashMap<String, serde_json::Value>,
  /// Timestamp when this snapshot was loaded from the database.
  pub loaded_at: Instant,
}

impl Default for ConfigOverrides {
  fn default() -> Self {
    Self {
      overrides: HashMap::new(),
      loaded_at: Instant::now(),
    }
  }
}

impl ConfigOverrides {
  /// Creates a timestamped snapshot from validated live values.
  pub fn new(overrides: HashMap<String, serde_json::Value>) -> Self {
    Self {
      overrides,
      loaded_at: Instant::now(),
    }
  }

  /// Builds the live snapshot from the immutable file baseline plus current
  /// database rows. Including file values for live descriptors means removing
  /// a DB row restores the file value immediately instead of retaining the
  /// startup-time database value held by the final AppConfig.
  pub fn from_sources(base: &AppConfig, database: &HashMap<String, serde_json::Value>) -> Self {
    let serialized = serde_json::to_value(base).expect("typed AppConfig must serialize");
    let mut overrides = HashMap::new();
    for descriptor in CONFIG_REGISTRY.iter().filter(|descriptor| !descriptor.restart_required) {
      let value = database
        .get(descriptor.path)
        .cloned()
        .or_else(|| config_value_at_path(&serialized, descriptor.path).cloned());
      if let Some(value) = value {
        overrides.insert(descriptor.path.to_string(), value);
      }
    }
    Self::new(overrides)
  }
}

/// Resolve one immutable preview policy snapshot for a newly admitted request.
///
/// Live fields come only from the shared validated override snapshot. Fields
/// marked restart-bound are deliberately retained from `base.preview`, because
/// the corresponding semaphores and caches were constructed at process start.
pub fn resolve_preview_config(base: &AppConfig, overrides: &ConfigOverrides) -> PreviewConfig {
  let mut value = serde_json::to_value(&base.preview).expect("typed PreviewConfig must serialize");
  let object = value
    .as_object_mut()
    .expect("typed PreviewConfig must serialize as an object");
  for descriptor in CONFIG_REGISTRY
    .iter()
    .filter(|descriptor| descriptor.path.starts_with("preview.") && !descriptor.restart_required)
  {
    let Some(candidate) = overrides.overrides.get(descriptor.path) else {
      continue;
    };
    let field = descriptor
      .path
      .strip_prefix("preview.")
      .expect("preview descriptor prefix");
    object.insert(field.to_string(), candidate.clone());
  }
  serde_json::from_value(value).expect("validated preview overrides must retain the typed schema")
}

/// Runs the bounded recovery poll for missed configuration invalidations.
///
/// The same refresh function is also called immediately after local writes and
/// Redis wake-ups. This loop owns no separate projection or lifecycle rules.
#[instrument(skip_all, fields(interval_secs = interval.as_secs()))]
pub async fn run_config_reload_loop(
  pool: PgPool,
  file_config: Arc<AppConfig>,
  config_overrides: Arc<RwLock<ConfigOverrides>>,
  transcription: Arc<crate::transcription_runtime::TranscriptionRuntime>,
  logging: Option<Arc<crate::logging::LoggingService>>,
  metrics: Arc<myoxus_application::metrics::MetricsService>,
  mut shutdown: tokio::sync::watch::Receiver<bool>,
  interval: Duration,
) {
  debug!("config reload loop started");

  loop {
    tokio::select! {
      biased;
      changed = shutdown.changed() => {
        if changed.is_err() || *shutdown.borrow() { break; }
      }
      _ = tokio::time::sleep(interval) => {}
    }

    // Re-check shutdown after waking — the sleep branch won the select
    // but shutdown may have been signalled concurrently.
    if *shutdown.borrow() {
      break;
    }

    match refresh_config_overrides(
      &pool,
      &file_config,
      &config_overrides,
      Some(transcription.as_ref()),
      logging.as_deref(),
      Some(metrics.as_ref()),
    )
    .await
    {
      Ok(overrides) => {
        debug!(
          count = overrides.overrides.len(),
          "config_reload: loaded config from DB"
        );
      }
      Err(e) => {
        warn!(error = %e, "config_reload: failed to read config from DB (keeping previous values)");
      }
    }
  }

  debug!("config reload loop stopped");
}

/// Query `app_configs` for all keys and build a [`ConfigOverrides`].
pub async fn refresh_config_overrides(
  pool: &PgPool,
  file_config: &AppConfig,
  target: &Arc<RwLock<ConfigOverrides>>,
  transcription: Option<&crate::transcription_runtime::TranscriptionRuntime>,
  logging: Option<&crate::logging::LoggingService>,
  metrics: Option<&myoxus_application::metrics::MetricsService>,
) -> Result<ConfigOverrides, myoxus_infrastructure::app_config::AppConfigLoadError> {
  let database = myoxus_infrastructure::app_config::load_validated_app_config_values(pool).await?;
  file_config
    .clone()
    .with_database_overrides(&database)
    .map_err(|error| myoxus_infrastructure::app_config::AppConfigLoadError::InvalidCandidate(error.to_string()))?;
  let overrides = ConfigOverrides::from_sources(file_config, &database);
  publish_config_overrides(target, overrides.clone(), transcription).await;
  if let Some(logging) = logging
    && let Some(filter) = overrides
      .overrides
      .get("logging.level")
      .and_then(serde_json::Value::as_str)
    && let Err(error) = logging.apply_canonical_filter(filter).await
  {
    warn!(%error, "config_reload: failed to apply logging.level");
  }
  if let Some(metrics) = metrics {
    metrics.set_policy(metrics_policy_from_overrides(file_config, &overrides.overrides));
  }
  Ok(overrides)
}

/// Publication and readiness invalidation share the live snapshot lock. Polling
/// an unchanged configuration leaves the last observed outcome intact.
pub(crate) async fn publish_config_overrides(
  target: &Arc<RwLock<ConfigOverrides>>,
  overrides: ConfigOverrides,
  transcription: Option<&crate::transcription_runtime::TranscriptionRuntime>,
) {
  let mut previous = target.write().await;
  let changed = CONFIG_REGISTRY
    .iter()
    .filter(|field| field.path.starts_with("transcription."))
    .any(|field| previous.overrides.get(field.path) != overrides.overrides.get(field.path));
  if changed && let Some(runtime) = transcription {
    runtime.invalidate().await;
  }
  *previous = overrides;
}

fn metrics_policy_from_overrides(
  base: &AppConfig,
  overrides: &HashMap<String, serde_json::Value>,
) -> myoxus_application::metrics::MetricsPolicy {
  let metrics = &base.metrics;
  myoxus_application::metrics::MetricsPolicy {
    enabled: overrides
      .get("metrics.enabled")
      .and_then(serde_json::Value::as_bool)
      .unwrap_or(metrics.enabled),
    categories: overrides
      .get("metrics.categories")
      .and_then(serde_json::Value::as_object)
      .map(|categories| {
        categories
          .iter()
          .filter_map(|(name, enabled)| enabled.as_bool().map(|enabled| (name.clone(), enabled)))
          .collect()
      })
      .unwrap_or_else(|| metrics.categories.clone()),
    label_workspace_id_enabled: overrides
      .get("metrics.label_workspace_id_enabled")
      .and_then(serde_json::Value::as_bool)
      .unwrap_or(metrics.label_workspace_id_enabled),
    cardinality_limit_per_metric: overrides
      .get("metrics.cardinality_limit_per_metric")
      .and_then(serde_json::Value::as_u64)
      .and_then(|value| u32::try_from(value).ok())
      .unwrap_or(metrics.cardinality_limit_per_metric),
  }
}

fn config_value_at_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
  path.split('.').try_fold(root, |value, segment| value.get(segment))
}

/// Merged configuration: combines immutable YAML config with runtime database overrides.
///
/// Coherent view over the startup snapshot and current live overrides.
///
/// Live database values replace the startup baseline immediately after local
/// writes or Redis invalidation. The bounded recovery poll only repairs missed
/// invalidations. Restart-bound descriptors always retain their startup value.
#[derive(Clone)]
pub struct EffectiveConfig {
  /// Immutable base configuration loaded from YAML files at startup.
  pub base: Arc<AppConfig>,
  /// Current database overrides snapshot.
  pub overrides: Arc<ConfigOverrides>,
}

impl EffectiveConfig {
  /// Create a new effective config combining base YAML and database overrides.
  pub fn new(base: Arc<AppConfig>, overrides: Arc<ConfigOverrides>) -> Self {
    Self { base, overrides }
  }

  /// Resolves one registered path from the coherent live snapshot. Live paths
  /// are always seeded from the file baseline and then replaced by DB values;
  /// restart-bound paths deliberately remain on the startup `AppConfig`.
  pub fn value(&self, path: &str) -> Option<serde_json::Value> {
    let descriptor = myoxus_contracts::effective_config::find_descriptor(path)?;
    if !descriptor.restart_required
      && let Some(value) = self.overrides.overrides.get(path)
    {
      return Some(value.clone());
    }
    let base = serde_json::to_value(self.base.as_ref()).ok()?;
    config_value_at_path(&base, path).cloned()
  }

  pub fn transcription(&self) -> crate::config::TranscriptionConfig {
    let values = CONFIG_REGISTRY
      .iter()
      .filter(|field| field.path.starts_with("transcription."))
      .filter_map(|field| {
        self
          .value(field.path)
          .map(|value| (field.module_and_key().1.to_string(), value))
      })
      .collect::<serde_json::Map<_, _>>();
    serde_json::from_value(serde_json::Value::Object(values))
      .expect("validated transcription snapshot must retain its typed schema")
  }

  /// Snapshot the existing PDF resource contract, including live Admin overrides.
  /// Removal falls back to the immutable file/ENV baseline, never startup DB data.
  pub fn pdf_export_limits(&self) -> Result<crate::config::PdfExportLimitsConfig, String> {
    let mut values = serde_json::Map::new();
    for key in [
      "max_concurrent_per_workspace",
      "max_input_blocks",
      "max_pages",
      "render_timeout_seconds",
      "max_memory_mb",
    ] {
      let value = self
        .value(&format!("pdf_export.limits.{key}"))
        .ok_or_else(|| "PDF resource configuration is unavailable".to_owned())?;
      values.insert(key.into(), value);
    }
    let limits: crate::config::PdfExportLimitsConfig = serde_json::from_value(serde_json::Value::Object(values))
      .map_err(|_| "invalid PDF resource configuration".to_owned())?;
    if limits.max_memory_mb < 64 {
      return Err("invalid PDF memory budget".into());
    }
    Ok(limits)
  }

  /// Resolve once at the start of a nightly pass; invalid out-of-band values
  /// fail closed rather than becoming an unlimited or immediate-delete policy.
  pub fn git_sync_retention_days(&self) -> Result<u32, String> {
    self
      .value("git_sync.retention_days")
      .and_then(|value| value.as_u64())
      .filter(|days| (1..=30).contains(days))
      .map(|days| days as u32)
      .ok_or_else(|| "git_sync.retention_days must be an integer in 1..=30".into())
  }

  /// Resolves a registered boolean path from the effective snapshot.
  pub fn bool(&self, path: &str) -> Option<bool> {
    self.value(path).and_then(|value| value.as_bool())
  }

  /// Resolves a registered string path from the effective snapshot.
  pub fn string(&self, path: &str) -> Option<String> {
    self.value(path).and_then(|value| value.as_str().map(ToOwned::to_owned))
  }

  /// Resolves a registered string-array path, discarding no valid values.
  /// Persisted arrays are shape-validated before they enter the snapshot.
  pub fn string_array(&self, path: &str) -> Option<Vec<String>> {
    self.value(path).and_then(|value| {
      value.as_array().map(|items| {
        items
          .iter()
          .filter_map(|item| item.as_str().map(ToOwned::to_owned))
          .collect()
      })
    })
  }

  /// Resolve limits and lifecycle settings for a newly staged workspace
  /// import. Queue concurrency deliberately remains the startup value; every
  /// other field follows the universal runtime app-config overlay.
  pub fn workspace_import(&self) -> crate::config::WorkspaceImportConfig {
    self
      .base
      .workspace
      .r#import
      .with_runtime_overrides(&self.overrides.overrides)
  }

  /// Snapshot the effective preview policy for one newly admitted request.
  pub fn preview(&self) -> PreviewConfig {
    resolve_preview_config(&self.base, &self.overrides)
  }

  /// Resolve the distributed Socket.IO connection-admission limit from the
  /// current database snapshot. Invalid out-of-band rows cannot weaken or
  /// disable the startup-validated YAML policy.
  pub fn websocket_max_connections_per_second_per_client(&self) -> u32 {
    resolve_websocket_connection_admission_limit(
      self.base.websocket.max_connections_per_second_per_client,
      &self.overrides.overrides,
    )
  }

  /// Resolve the startup-materialized server origin.
  ///
  /// Origin participates in links, CORS, and multiple long-lived services, so
  /// a DB change is pending until canonical writeback and restart. Reading a
  /// live alias row here previously made only some consumers change.
  pub fn server_origin(&self) -> String {
    self.base.server.origin.clone()
  }

  /// Resolve server session TTL (in seconds): check `server.session_ttl` override, fall back to YAML.
  /// Enforces a minimum of 60 seconds to prevent accidental lockouts.
  pub fn server_session_ttl(&self) -> i64 {
    let raw = self
      .overrides
      .overrides
      .get("server.session_ttl")
      .and_then(|v| v.as_i64())
      .unwrap_or(self.base.server.session_ttl);
    if raw < 60 {
      tracing::warn!(raw, "server.session_ttl below minimum (60s), clamping to 60");
      60
    } else {
      raw
    }
  }

  /// Resolve copilot default provider: check `copilot.default_provider` override, fall back to YAML.
  pub fn copilot_default_provider(&self) -> String {
    self
      .overrides
      .overrides
      .get("copilot.default_provider")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string())
      .unwrap_or_else(|| self.base.copilot.default_provider.clone())
  }

  /// Resolve copilot embedding model: check `copilot.embedding_model` override, fall back to YAML.
  pub fn copilot_embedding_model(&self) -> String {
    self
      .overrides
      .overrides
      .get("copilot.embedding_model")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string())
      .unwrap_or_else(|| self.base.copilot.embedding_model.clone())
  }

  /// Resolve database max connections: check `database.maxConnections` override, fall back to YAML.
  /// Enforces minimum of 1 and safe u64→u32 conversion, falling back to YAML default on overflow.
  pub fn database_max_connections(&self) -> u32 {
    let val = self
      .overrides
      .overrides
      .get("database.maxConnections")
      .and_then(|v| v.as_u64())
      .and_then(|n| u32::try_from(n).ok())
      .unwrap_or(self.base.database.max_connections);
    if val == 0 {
      tracing::warn!("database.maxConnections is 0, clamping to 1");
      1
    } else {
      val
    }
  }

  /// Resolve logging level: check `logging.level` override, fall back to YAML.
  pub fn logging_level(&self) -> String {
    self
      .overrides
      .overrides
      .get("logging.level")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string())
      .unwrap_or_else(|| self.base.logging.level.clone())
  }
}

#[cfg(test)]
mod tests {
  use myoxus_contracts::config_document::decode_typed_yaml_document;
  use std::fs;

  use super::*;

  #[test]
  fn git_retention_snapshot_preserves_file_baseline_and_validates_live_overrides() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let mut config: AppConfig = decode_typed_yaml_document(&fs::read_to_string(path).unwrap()).unwrap();
    config.git_sync.retention_days = 14;
    let base = Arc::new(config);
    let snapshot = |values| EffectiveConfig::new(base.clone(), Arc::new(ConfigOverrides::new(values)));
    assert_eq!(snapshot(HashMap::new()).git_sync_retention_days().unwrap(), 14);
    assert_eq!(
      snapshot(HashMap::from([(
        "git_sync.retention_days".into(),
        serde_json::json!(3)
      )]))
      .git_sync_retention_days()
      .unwrap(),
      3
    );
    assert!(
      snapshot(HashMap::from([(
        "git_sync.retention_days".into(),
        serde_json::json!(0)
      )]))
      .git_sync_retention_days()
      .is_err()
    );
  }

  #[test]
  fn pdf_compiler_limits_preserve_defaults_live_overrides_and_removal() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let mut config: AppConfig = decode_typed_yaml_document(&fs::read_to_string(path).unwrap()).unwrap();
    config.pdf_export.limits.render_timeout_seconds = 19;
    config.pdf_export.limits.max_input_blocks = 73;
    let base = Arc::new(config);
    let mut map = HashMap::new();
    map.insert("pdf_export.limits.max_memory_mb".into(), serde_json::json!(512));
    map.insert("pdf_export.limits.max_pages".into(), serde_json::json!(7));
    let effective = EffectiveConfig::new(base.clone(), Arc::new(ConfigOverrides::new(map.clone())));
    let limits = effective.pdf_export_limits().unwrap();
    assert_eq!(limits.max_memory_mb, 512);
    assert_eq!(limits.max_pages, 7);
    assert_eq!(limits.render_timeout_seconds, 19);
    assert_eq!(limits.max_input_blocks, 73);
    map.remove("pdf_export.limits.max_memory_mb");
    let effective = EffectiveConfig::new(base, Arc::new(ConfigOverrides::new(map)));
    assert_eq!(effective.pdf_export_limits().unwrap().max_memory_mb, 1024);
  }

  #[test]
  fn metrics_policy_projects_every_live_registry_field() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let base: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");
    let overrides = HashMap::from([
      ("metrics.enabled".to_string(), serde_json::json!(false)),
      (
        "metrics.categories".to_string(),
        serde_json::json!({"auth": false, "workspace": true}),
      ),
      (
        "metrics.label_workspace_id_enabled".to_string(),
        serde_json::json!(true),
      ),
      (
        "metrics.cardinality_limit_per_metric".to_string(),
        serde_json::json!(321),
      ),
    ]);

    let policy = metrics_policy_from_overrides(&base, &overrides);
    assert!(!policy.enabled);
    assert_eq!(policy.categories.get("auth"), Some(&false));
    assert_eq!(policy.categories.get("workspace"), Some(&true));
    assert!(policy.label_workspace_id_enabled);
    assert_eq!(policy.cardinality_limit_per_metric, 321);
  }

  #[test]
  fn workspace_import_hot_resolves_operation_limits_but_not_worker_concurrency() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let base: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");
    let startup_concurrency = base.workspace.r#import.worker_concurrency;
    let overrides = ConfigOverrides {
      overrides: HashMap::from([
        (
          "workspace.import.max_upload_bytes".to_string(),
          serde_json::json!(33_554_432),
        ),
        (
          "workspace.import.max_expanded_bytes".to_string(),
          serde_json::json!(16_777_216),
        ),
        (
          "workspace.import.max_entry_bytes".to_string(),
          serde_json::json!(67_108_864),
        ),
        (
          "workspace.import.max_sqlite_bytes".to_string(),
          serde_json::json!(67_108_864),
        ),
        (
          "workspace.import.max_asset_bytes".to_string(),
          serde_json::json!(67_108_864),
        ),
        ("workspace.import.max_documents".to_string(), serde_json::json!(7)),
        ("workspace.import.worker_concurrency".to_string(), serde_json::json!(8)),
      ]),
      loaded_at: Instant::now(),
    };

    let resolved = EffectiveConfig::new(Arc::new(base), Arc::new(overrides)).workspace_import();
    assert_eq!(resolved.max_upload_bytes, 33_554_432);
    assert_eq!(resolved.max_expanded_bytes, 16_777_216);
    assert_eq!(resolved.max_entry_bytes, 16_777_216);
    assert_eq!(resolved.max_sqlite_bytes, 33_554_432);
    assert_eq!(resolved.max_asset_bytes, 16_777_216);
    assert_eq!(resolved.max_documents, 7);
    assert_eq!(resolved.worker_concurrency, startup_concurrency);
  }

  #[test]
  fn preview_resolver_maps_every_field_and_preserves_restart_bound_values() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let base: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");
    let serialized = serde_json::to_value(&base.preview).expect("serialize PreviewConfig");
    let fields = serialized.as_object().expect("PreviewConfig object");
    let registered = myoxus_contracts::effective_config::CONFIG_REGISTRY
      .iter()
      .filter_map(|descriptor| descriptor.path.strip_prefix("preview."))
      .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
      registered.len(),
      fields.len(),
      "every PreviewConfig field needs one descriptor"
    );
    assert!(fields.keys().all(|field| registered.contains(field.as_str())));

    let overrides = ConfigOverrides {
      overrides: HashMap::from([
        ("preview.max_projected_blocks".to_string(), serde_json::json!(12)),
        ("preview.request_timeout_ms".to_string(), serde_json::json!(9_000)),
        ("preview.retry_count".to_string(), serde_json::json!(2)),
        ("preview.max_in_flight_requests".to_string(), serde_json::json!(99)),
        (
          "preview.output_cache_max_bytes".to_string(),
          serde_json::json!(268_435_456),
        ),
      ]),
      loaded_at: Instant::now(),
    };
    let resolved = resolve_preview_config(&base, &overrides);
    assert_eq!(resolved.max_projected_blocks, 12);
    assert_eq!(resolved.request_timeout_ms, 9_000);
    assert_eq!(resolved.retry_count, 2);
    assert_eq!(resolved.max_in_flight_requests, base.preview.max_in_flight_requests);
    assert_eq!(resolved.output_cache_max_bytes, base.preview.output_cache_max_bytes);

    let reset = resolve_preview_config(&base, &ConfigOverrides::default());
    assert_eq!(
      reset, base.preview,
      "removing an override must recover the file baseline"
    );
  }

  #[test]
  fn websocket_connection_admission_hot_resolves_valid_runtime_override() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config/default.yaml");
    let raw = fs::read_to_string(path).expect("read bundled config");
    let base: AppConfig = decode_typed_yaml_document(&raw).expect("parse bundled config");
    assert_eq!(base.websocket.max_connections_per_second_per_client, 10);

    let overrides = ConfigOverrides {
      overrides: HashMap::from([(
        "websocket.max_connections_per_second_per_client".to_string(),
        serde_json::json!(2),
      )]),
      loaded_at: Instant::now(),
    };
    let effective = EffectiveConfig::new(Arc::new(base.clone()), Arc::new(overrides));
    assert_eq!(effective.websocket_max_connections_per_second_per_client(), 2);

    let invalid = ConfigOverrides {
      overrides: HashMap::from([(
        "websocket.max_connections_per_second_per_client".to_string(),
        serde_json::json!(0),
      )]),
      loaded_at: Instant::now(),
    };
    let effective = EffectiveConfig::new(Arc::new(base), Arc::new(invalid));
    assert_eq!(effective.websocket_max_connections_per_second_per_client(), 10);
  }
}
