use async_graphql::{Enum, Result, SimpleObject};
use chrono::{DateTime, Utc};
use myoxus_contracts::effective_config::{
  CONFIG_REGISTRY, ConfigDescriptor, ConfigSourceSnapshot, ConfigValueType, EffectiveConfigSource,
  RuntimeEffectiveState, find_descriptor, is_nullable_config_path, is_sensitive_config_key,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::graphql::auth::UserType;
use crate::state::ApiState;

use super::UpdateAppConfigInput;
use super::config::{set_json_path_value, validate_update};

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
pub enum AdminConfigValueType {
  #[graphql(name = "Boolean")]
  Boolean,
  #[graphql(name = "Number")]
  Number,
  #[graphql(name = "String")]
  String,
  #[graphql(name = "Object")]
  Object,
  #[graphql(name = "Array")]
  Array,
}

impl From<ConfigValueType> for AdminConfigValueType {
  fn from(value: ConfigValueType) -> Self {
    match value {
      ConfigValueType::Boolean => Self::Boolean,
      ConfigValueType::Number => Self::Number,
      ConfigValueType::String => Self::String,
      ConfigValueType::Object => Self::Object,
      ConfigValueType::Array => Self::Array,
    }
  }
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigFieldType {
  pub path: String,
  pub key: String,
  pub label: String,
  pub group_key: String,
  pub value_type: AdminConfigValueType,
  pub sensitive: bool,
  #[graphql(name = "enum")]
  pub enum_values: Vec<String>,
  pub min: Option<i64>,
  pub max: Option<i64>,
  pub help_text: Option<String>,
  /// Server-owned fallback used when an older or partial client snapshot omits
  /// this field. Sensitive fields never expose their startup value here.
  pub default_value: Option<Value>,
  pub value: Option<Value>,
  pub requires_restart: bool,
  pub database_writable: bool,
  pub immediate_apply: bool,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigGroupType {
  pub group_key: String,
  pub label: String,
  pub help_text: Option<String>,
  pub fields: Vec<AdminConfigFieldType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigModuleType {
  pub module: String,
  pub label: String,
  pub groups: Vec<AdminConfigGroupType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigSnapshotType {
  pub modules: Vec<AdminConfigModuleType>,
  /// Stable, scrubbed revision of the projected schema or values. Sensitive
  /// material contributes only set/unset state and can never be recovered from
  /// this digest.
  pub revision: String,
  /// Provenance/lifecycle projection for config fields owned by the shared
  /// live resolver. This remains bounded until registry code generation lands.
  pub effective_fields: Vec<AdminEffectiveConfigFieldType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminEffectiveConfigFieldType {
  pub path: String,
  pub configured_value: Option<Value>,
  pub runtime_effective_value: Option<Value>,
  pub is_set: bool,
  pub winning_source: Option<String>,
  pub winning_key: Option<String>,
  pub overridden_sources: Vec<String>,
  pub runtime_effective_state: String,
  pub requires_restart: bool,
  pub sensitive: bool,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigFieldErrorType {
  pub module: String,
  pub key: String,
  pub path: String,
  pub message: String,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct AdminConfigUpdateResultType {
  pub applied: bool,
  /// Optional runtime-overlay publication outcome. `failed` accompanies a
  /// successful DB commit and must be rendered as a recovery warning.
  pub writeback: Option<String>,
  pub config: AdminConfigSnapshotType,
  pub field_errors: Vec<AdminConfigFieldErrorType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct ConfigChangelogEntryType {
  pub id: async_graphql::ID,
  pub config_key: String,
  #[graphql(name = "oldValue")]
  pub old_value: Option<Value>,
  #[graphql(name = "newValue")]
  pub new_value: Value,
  #[graphql(name = "changedBy")]
  pub changed_by: Option<UserType>,
  #[graphql(name = "changedAt")]
  pub changed_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct AdminConfigFieldRecord {
  path: String,
  key: String,
  label: String,
  group_key: String,
  value_type: AdminConfigValueType,
  sensitive: bool,
  enum_values: Vec<String>,
  min: Option<i64>,
  max: Option<i64>,
  help_text: Option<String>,
  default_value: Option<Value>,
  value: Option<Value>,
  requires_restart: bool,
  database_writable: bool,
  immediate_apply: bool,
}

#[instrument(skip_all)]
pub(crate) async fn load_admin_config_json(state: &ApiState) -> Result<Value> {
  // Read the next-startup baseline, including successful overlay removals.
  // Serializing the running config would resurrect its startup DB overrides.
  let baseline = crate::config::AppConfig::configured_baseline()
    .map_err(|_| async_graphql::Error::new("Configured source baseline is unavailable"))?;
  let mut config = serde_json::to_value(&baseline)
    .map_err(|_| async_graphql::Error::new("Configured source baseline cannot be projected"))?;
  if let Some(pool) = state.metrics_pool() {
    let rows = myoxus_infrastructure::app_config::load_validated_app_config_values(&pool)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?;
    for (id, value) in rows {
      let descriptor =
        find_descriptor(&id).ok_or_else(|| async_graphql::Error::new(format!("unknown app_configs path `{id}`")))?;
      if !descriptor.database_writable() && id != "git_sync.https_ca_bundle_path" {
        return Err(async_graphql::Error::new(format!(
          "file-only path `{id}` must not be stored in app_configs"
        )));
      }
      set_json_path_value(&mut config, &id, value);
    }
  }
  Ok(config)
}

pub(crate) fn build_admin_config_snapshot(config: &Value, include_values: bool) -> AdminConfigSnapshotType {
  if !config.is_object() {
    return AdminConfigSnapshotType {
      modules: Vec::new(),
      revision: admin_config_snapshot_revision(config, include_values),
      effective_fields: Vec::new(),
    };
  }

  let mut modules = Vec::new();
  let module_names = CONFIG_REGISTRY
    .iter()
    .map(|descriptor| descriptor.module_and_key().0)
    .collect::<std::collections::BTreeSet<_>>();
  for module in module_names {
    let records = CONFIG_REGISTRY
      .iter()
      .filter(|descriptor| descriptor.module_and_key().0 == module)
      .filter_map(|descriptor| {
        config_value_at_path(config, descriptor.path).map(|value| build_field_record(descriptor, value, include_values))
      })
      .collect::<Vec<_>>();

    let mut groups: Vec<AdminConfigGroupType> = Vec::new();
    for record in records {
      if let Some(group) = groups.iter_mut().find(|group| group.group_key == record.group_key) {
        group.fields.push(to_field_type(&record));
      } else {
        let group_label = humanize_config_label(&record.group_key);
        groups.push(AdminConfigGroupType {
          group_key: record.group_key.clone(),
          label: group_label.clone(),
          help_text: Some(format!("Fields grouped under {}.", group_label)),
          fields: vec![to_field_type(&record)],
        });
      }
    }

    modules.push(AdminConfigModuleType {
      module: module.to_string(),
      label: module_label(module),
      groups,
    });
  }

  AdminConfigSnapshotType {
    modules,
    revision: admin_config_snapshot_revision(config, include_values),
    effective_fields: Vec::new(),
  }
}

pub(crate) fn build_admin_config_schema_snapshot(config: &Value) -> AdminConfigSnapshotType {
  build_admin_config_snapshot(config, false)
}

pub(crate) fn build_admin_config_values_snapshot(config: &Value) -> AdminConfigSnapshotType {
  build_admin_config_snapshot(config, true)
}

pub(crate) async fn attach_effective_config_fields(
  state: &ApiState,
  mut snapshot: AdminConfigSnapshotType,
) -> Result<AdminConfigSnapshotType> {
  let overrides = if let Some(pool) = state.metrics_pool() {
    myoxus_infrastructure::app_config::load_validated_app_config_values(&pool)
      .await
      .map_err(|error| async_graphql::Error::new(error.to_string()))?
  } else {
    std::collections::HashMap::new()
  };
  // Provenance and reset fallbacks come from the file/ENV baseline; active
  // restart-bound values come from the actual typed startup configuration,
  // including the DB overrides that were loaded before the engine was built.
  let runtime = ConfigSourceSnapshot::from_resolved_values(
    &serde_json::to_value(&state.config).map_err(|error| async_graphql::Error::new(error.to_string()))?,
  );
  let baseline = crate::config::AppConfig::configured_baseline()
    .map_err(|_| async_graphql::Error::new("Configured source baseline is unavailable"))?;
  // ENV sources retain strings for provenance; lifecycle comparisons use the
  // same typed values as startup so "60" and 60 do not imply a restart.
  let configured = ConfigSourceSnapshot::from_resolved_values(
    &serde_json::to_value(&baseline)
      .map_err(|_| async_graphql::Error::new("Configured source baseline cannot be projected"))?,
  );
  snapshot.effective_fields = CONFIG_REGISTRY
    .iter()
    .map(|descriptor| {
      baseline
        .source_snapshot
        .resolve(descriptor, &overrides)
        .and_then(|mut field| {
          if let Some(value) = configured.resolve(descriptor, &overrides)?.configured_value {
            field.configured_value = Some(value);
          }
          if descriptor.restart_required {
            field.runtime_effective_value = runtime
              .resolve(descriptor, &std::collections::HashMap::new())?
              .runtime_effective_value;
            field.runtime_effective_state = if field.configured_value != field.runtime_effective_value {
              RuntimeEffectiveState::PendingRestart
            } else {
              RuntimeEffectiveState::Effective
            };
          }
          Ok(field)
        })
        .map(|field| AdminEffectiveConfigFieldType {
          path: field.path,
          configured_value: field.configured_value,
          runtime_effective_value: field.runtime_effective_value,
          is_set: field.is_set,
          winning_source: field.winning_source.map(effective_source_name),
          winning_key: field.winning_key,
          overridden_sources: field
            .overridden_sources
            .into_iter()
            .map(|source| format!("{:?}:{}", source.source, source.source_key))
            .collect(),
          runtime_effective_state: runtime_effective_state_name(field.runtime_effective_state).to_string(),
          requires_restart: field.restart_required,
          sensitive: field.sensitive,
        })
        .map_err(|error| async_graphql::Error::new(error.to_string()))
    })
    .collect::<Result<Vec<_>>>()?;
  Ok(snapshot)
}

fn effective_source_name(source: EffectiveConfigSource) -> String {
  match source {
    EffectiveConfigSource::Default => "DEFAULT",
    EffectiveConfigSource::RunModeYaml => "RUN_MODE_YAML",
    EffectiveConfigSource::LocalYaml => "LOCAL_YAML",
    EffectiveConfigSource::RuntimeOverlay => "RUNTIME_OVERLAY",
    EffectiveConfigSource::Environment => "ENVIRONMENT",
    EffectiveConfigSource::SecretFile => "SECRET_FILE",
    EffectiveConfigSource::Database => "DATABASE",
  }
  .to_string()
}

fn runtime_effective_state_name(state: RuntimeEffectiveState) -> &'static str {
  match state {
    RuntimeEffectiveState::Effective => "EFFECTIVE",
    RuntimeEffectiveState::PendingRestart => "PENDING_RESTART",
  }
}

#[cfg(test)]
pub(crate) fn admin_config_flattened_paths(config: &Value) -> Vec<String> {
  let mut paths = Vec::new();
  if let Some(root) = config.as_object() {
    for (module, module_value) in root {
      collect_paths(module, module_value, "", &mut paths);
    }
  }
  paths
}

#[instrument(skip_all)]
pub(crate) async fn apply_admin_config_updates(
  state: &ApiState,
  updated_by: Uuid,
  updates: Vec<UpdateAppConfigInput>,
) -> Result<(
  Value,
  Vec<AdminConfigFieldErrorType>,
  myoxus_infrastructure::app_config::WritebackOutcome,
)> {
  let snapshot = load_admin_config_json(state).await?;
  let mut errors = Vec::new();
  let mut normalized_updates = Vec::with_capacity(updates.len());

  for update in updates {
    let module = update.module.trim();
    let key = update.key.trim();
    let path = format!("{module}.{key}");
    if find_descriptor(&path).is_some_and(|descriptor| !descriptor.database_writable()) {
      errors.push(AdminConfigFieldErrorType {
        module: module.to_string(),
        key: key.to_string(),
        path: path.clone(),
        message: format!("{path} is configured through YAML or environment variables only"),
      });
      continue;
    }
    let validation = validate_update(update.clone());
    if !validation.valid {
      errors.push(AdminConfigFieldErrorType {
        module: validation.module.trim().to_string(),
        key: validation.key.trim().to_string(),
        path: format!("{}.{}", validation.module.trim(), validation.key.trim()),
        message: validation
          .error
          .unwrap_or_else(|| "invalid app config update".to_string()),
      });
      continue;
    }

    let value = update.value.unwrap_or(Value::Null);
    let value = find_descriptor(&path)
      .filter(|descriptor| descriptor.sensitive)
      .and_then(|_| config_value_at_path(&snapshot, &path))
      .map_or(value.clone(), |current| restore_masked_value(&value, current));
    normalized_updates.push((update.module.trim().to_string(), update.key.trim().to_string(), value));
  }

  if !errors.is_empty() {
    return Ok((
      snapshot,
      errors,
      myoxus_infrastructure::app_config::WritebackOutcome::Disabled,
    ));
  }

  let setup_update_count = normalized_updates
    .iter()
    .filter(|(module, key, _)| module == "system" && key == "setupCompleted")
    .count();
  if setup_update_count > 0 {
    if normalized_updates.len() != 1 {
      return Ok((
        snapshot,
        vec![AdminConfigFieldErrorType {
          module: "system".to_string(),
          key: "setupCompleted".to_string(),
          path: myoxus_infrastructure::app_config::SETUP_COMPLETED_CONFIG_KEY.to_string(),
          message: "setup completion must be updated separately from configuration".to_string(),
        }],
        myoxus_infrastructure::app_config::WritebackOutcome::Disabled,
      ));
    }

    let (_, _, value) = normalized_updates.pop().expect("one validated setup update");
    let completed = value
      .as_bool()
      .ok_or_else(|| async_graphql::Error::new("system.setupCompleted must be boolean"))?;
    let mut saved = snapshot;
    let change = state
      .setup_state()
      .set_setup_completed(completed, Some(updated_by))
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    record_config_change(
      state,
      myoxus_infrastructure::app_config::SETUP_COMPLETED_CONFIG_KEY,
      change.previous.map(Value::Bool),
      value.clone(),
      updated_by,
    )
    .await;
    set_json_path_value(
      &mut saved,
      myoxus_infrastructure::app_config::SETUP_COMPLETED_CONFIG_KEY,
      value,
    );
    return Ok((
      saved,
      Vec::new(),
      myoxus_infrastructure::app_config::WritebackOutcome::Disabled,
    ));
  }

  let mut candidate = snapshot.clone();
  for (module, key, value) in &normalized_updates {
    let path = format!("{module}.{key}");
    if !value.is_null() || is_nullable_config_path(&path) {
      set_json_path_value(&mut candidate, &path, value.clone());
    }
  }
  let complete_candidate = myoxus_contracts::effective_config::CONFIG_REGISTRY
    .iter()
    .filter_map(|descriptor| {
      config_value_at_path(&candidate, descriptor.path).map(|value| (descriptor.path.to_string(), value.clone()))
    })
    .collect();
  if let Err(message) = myoxus_contracts::effective_config::validate_config_candidate(&complete_candidate) {
    errors.push(AdminConfigFieldErrorType {
      module: "config".to_string(),
      key: "candidate".to_string(),
      path: "config.candidate".to_string(),
      message,
    });
    return Ok((
      snapshot,
      errors,
      myoxus_infrastructure::app_config::WritebackOutcome::Disabled,
    ));
  }

  let pool = state
    .metrics_pool()
    .ok_or_else(|| async_graphql::Error::new("configuration database pool unavailable"))?;

  let mutations = normalized_updates
    .iter()
    .map(|(module, key, value)| {
      let path = format!("{module}.{key}");
      if value.is_null() && !is_nullable_config_path(&path) {
        myoxus_infrastructure::app_config::ConfigMutation::Remove { path }
      } else {
        myoxus_infrastructure::app_config::ConfigMutation::Set {
          path,
          value: value.clone(),
        }
      }
    })
    .collect::<Vec<_>>();
  let result = myoxus_infrastructure::app_config::write_config_batch(
    &pool,
    &mutations,
    myoxus_infrastructure::app_config::ConfigBatchMode::Partial,
    Some(updated_by),
    &crate::config::AppConfigStartupValidator,
  )
  .await
  .map_err(|error| async_graphql::Error::new(error.to_string()))?;
  let mut saved = snapshot;
  for change in &result.changes {
    // A released override is null in this immediate response. The subsequent
    // refresh/read resolves and reports its lower-precedence effective value.
    set_json_path_value(
      &mut saved,
      &change.path,
      change.new_value.clone().unwrap_or(Value::Null),
    );
  }
  record_committed_config_changes(state, &result.changes, updated_by).await;
  Ok((saved, Vec::new(), result.writeback))
}

#[instrument(skip_all)]
pub(crate) async fn admin_update_config_result(
  state: &ApiState,
  updated_by: Uuid,
  updates: Vec<UpdateAppConfigInput>,
) -> Result<AdminConfigUpdateResultType> {
  let invalidates_oidc_metadata = updates
    .iter()
    .any(|update| update.module.trim() == "oauth" && matches!(update.key.trim(), "providers.oidc" | "providers.apple"));
  let (saved, field_errors, writeback) = apply_admin_config_updates(state, updated_by, updates).await?;
  let applied = field_errors.is_empty();

  // P84-H-12/H-13: Invalidate all config caches after successful update.
  // Config keys span app_config, server_config, and throttle_config domains —
  // invalidate all three to guarantee consistency.
  if applied {
    state.query_cache.server_config.invalidate_all();
    state.query_cache.metrics_server_config.record_invalidation_local();
    state.query_cache.throttle_config.invalidate_all();
    state.query_cache.metrics_throttle_config.record_invalidation_local();
    tracing::info!(
      cache_name = "server_config,throttle_config",
      reason = "adminUpdateConfig",
      "cache invalidated"
    );
    // P84-I: Notify other instances via Redis Pub/Sub.
    state.publish_cache_invalidation("app_config", "all").await;
    state.publish_cache_invalidation("server_config", "all").await;
    state.publish_cache_invalidation("throttle_config", "all").await;

    if invalidates_oidc_metadata {
      // Provider endpoint, issuer or JWKS changes make previously fetched OIDC
      // metadata stale. These caches contain only public IdP metadata, but
      // flushing them avoids a short post-update mismatch window.
      state.query_cache.oidc_discovery.invalidate_all();
      state.query_cache.oidc_jwks.invalidate_all();
      tracing::info!(
        cache_name = "oidc_discovery,oidc_jwks",
        reason = "adminUpdateConfig",
        "cache invalidated"
      );
      state.publish_cache_invalidation("oidc_discovery", "all").await;
      state.publish_cache_invalidation("oidc_jwks", "all").await;
    }

    // Apply canonical cache fixed-TTL overrides to QueryCache atomics.
    // When an admin sets (or clears) a fixed TTL, update the AtomicU64 immediately
    // so the new TTL takes effect for all future cache insertions.
    if let Some(tuning) = saved.get("cache").and_then(|v| v.as_object()) {
      let qc = &state.query_cache;
      let cc = &state.config.cache;
      let pairs: [(&std::sync::Arc<std::sync::atomic::AtomicU64>, Option<u64>, u64); 4] = [
        (
          &qc.current_ttl_server_config,
          tuning.get("server_config_fixed_ttl_seconds").and_then(|v| v.as_u64()),
          cc.server_config_ttl_seconds,
        ),
        (
          &qc.current_ttl_user_features,
          tuning.get("user_features_fixed_ttl_seconds").and_then(|v| v.as_u64()),
          cc.user_features_ttl_seconds,
        ),
        (
          &qc.current_ttl_throttle_config,
          tuning.get("throttle_config_fixed_ttl_seconds").and_then(|v| v.as_u64()),
          cc.throttle_config_ttl_seconds,
        ),
        (
          &qc.current_ttl_ws_settings,
          tuning.get("ws_settings_fixed_ttl_seconds").and_then(|v| v.as_u64()),
          cc.ws_settings_ttl_seconds,
        ),
      ];
      for (atomic, fixed_opt, fallback) in &pairs {
        let new_ttl = fixed_opt.unwrap_or(*fallback);
        atomic.store(new_ttl, Ordering::Release);
      }
      tracing::info!(reason = "cache admin update", "QueryCache TTLs updated");
    }

    // P104-C: Apply doc-cache fixed TTL overrides immediately to DocCache atomics.
    if let Some(tuning) = saved.get("cache").and_then(|v| v.as_object())
      && let Some(handles) = state.doc_cache_tuning()
    {
      let redis_cfg = &state.config.redis;
      let triples: [(&std::sync::Arc<std::sync::atomic::AtomicU64>, &str, u64); 4] = [
        (
          &handles.snapshot_ttl,
          "doc_snapshot_fixed_ttl_seconds",
          redis_cfg.cache_ttl_doc_snapshot_seconds,
        ),
        (
          &handles.metadata_ttl,
          "doc_metadata_fixed_ttl_seconds",
          redis_cfg.cache_ttl_doc_metadata_seconds,
        ),
        (
          &handles.metadata_projection_ttl,
          "doc_metadata_projection_fixed_ttl_seconds",
          redis_cfg.cache_ttl_doc_metadata_projection_seconds,
        ),
        (
          &handles.timestamps_ttl,
          "doc_timestamps_fixed_ttl_seconds",
          redis_cfg.cache_ttl_doc_timestamps_seconds,
        ),
      ];
      for (atomic, key, default_ttl) in &triples {
        let new_ttl = tuning.get(*key).and_then(|v| v.as_u64()).unwrap_or(*default_ttl);
        atomic.store(new_ttl, Ordering::Release);
      }
      tracing::info!(reason = "cache admin update", "DocCache TTLs updated");
    }

    if let Err(error) = state.refresh_config_overrides().await {
      // Persistence already succeeded. Keep the mutation result truthful and
      // let Redis plus the bounded poll repair this instance's live snapshot.
      warn!(%error, "admin config committed but local live refresh failed");
    }
  }

  let config = attach_effective_config_fields(state, build_admin_config_snapshot(&saved, true)).await?;
  Ok(AdminConfigUpdateResultType {
    applied,
    writeback: applied.then(|| writeback.as_str().to_string()),
    config,
    field_errors,
  })
}

fn to_field_type(record: &AdminConfigFieldRecord) -> AdminConfigFieldType {
  AdminConfigFieldType {
    path: record.path.clone(),
    key: record.key.clone(),
    label: record.label.clone(),
    group_key: record.group_key.clone(),
    value_type: record.value_type,
    sensitive: record.sensitive,
    enum_values: record.enum_values.clone(),
    min: record.min,
    max: record.max,
    help_text: record.help_text.clone(),
    default_value: record.default_value.clone(),
    value: record.value.clone(),
    requires_restart: record.requires_restart,
    database_writable: record.database_writable,
    immediate_apply: record.immediate_apply,
  }
}

#[cfg(test)]
fn collect_paths(_module: &str, _value: &Value, _path: &str, paths: &mut Vec<String>) {
  paths.extend(CONFIG_REGISTRY.iter().map(|descriptor| descriptor.path.to_string()));
}

fn config_value_at_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
  path.split('.').try_fold(root, |value, segment| value.get(segment))
}

fn is_secret_member(name: &str) -> bool {
  // OAuth inputs accept snake_case, while the canonical saved/readback object
  // uses camelCase. Both spellings must be masked at every nesting depth.
  matches!(
    name,
    "api_key" | "client_secret" | "clientSecret" | "hmac_key" | "key" | "password" | "private_key" | "secret" | "token"
  ) || name.ends_with("_secret")
    || name.ends_with("_password")
    || name.ends_with("_token")
}

/// Keep sensitive object structure editable while masking credential leaves.
/// Collapsing a provider map would also hide its non-secret endpoint and model.
fn redact_sensitive_value(value: &Value) -> Value {
  redact_sensitive_node(value, true)
}

fn redact_sensitive_node(value: &Value, mask_scalar: bool) -> Value {
  match value {
    Value::Object(object) => Value::Object(
      object
        .iter()
        .map(|(key, value)| {
          let value = if is_secret_member(key) && !value.is_null() {
            Value::String(myoxus_contracts::effective_config::MASKED_CONFIG_VALUE.to_string())
          } else {
            redact_sensitive_node(value, false)
          };
          (key.clone(), value)
        })
        .collect(),
    ),
    Value::Array(values) => Value::Array(values.iter().map(|value| redact_sensitive_node(value, false)).collect()),
    Value::Null => Value::Null,
    _ if mask_scalar => Value::String(myoxus_contracts::effective_config::MASKED_CONFIG_VALUE.to_string()),
    _ => value.clone(),
  }
}

/// Masked leaves sent back by Admin mean "leave unchanged". Resolve them
/// before shared validation and the transactional writer receive the value.
fn restore_masked_value(value: &Value, current: &Value) -> Value {
  if value.as_str() == Some(myoxus_contracts::effective_config::MASKED_CONFIG_VALUE) {
    return current.clone();
  }
  match value {
    Value::Object(object) => Value::Object(
      object
        .iter()
        .map(|(key, value)| {
          let current = current.get(key).unwrap_or(&Value::Null);
          (key.clone(), restore_masked_value(value, current))
        })
        .collect(),
    ),
    Value::Array(values) => Value::Array(
      values
        .iter()
        .enumerate()
        .map(|(index, value)| restore_masked_value(value, current.get(index).unwrap_or(&Value::Null)))
        .collect(),
    ),
    _ => value.clone(),
  }
}

fn build_field_record(descriptor: &ConfigDescriptor, value: &Value, include_values: bool) -> AdminConfigFieldRecord {
  let (module, path) = descriptor.module_and_key();
  let group_key = group_key_for_field(module, path);
  let label = humanize_config_label(path);
  AdminConfigFieldRecord {
    path: descriptor.path.to_string(),
    key: path.to_string(),
    label: label.clone(),
    group_key,
    value_type: descriptor.value_type.into(),
    sensitive: descriptor.sensitive,
    enum_values: descriptor.enum_values.iter().map(|s| s.to_string()).collect(),
    min: descriptor.min_value,
    max: descriptor.max_value,
    help_text: Some(format!("Configure {}.", label.to_lowercase())),
    default_value: (!descriptor.sensitive).then(|| value.clone()),
    value: include_values.then(|| {
      if descriptor.sensitive {
        redact_sensitive_value(value)
      } else {
        value.clone()
      }
    }),
    requires_restart: descriptor.restart_required,
    database_writable: descriptor.database_writable(),
    immediate_apply: descriptor.immediate_apply,
  }
}

fn admin_config_snapshot_revision(config: &Value, include_values: bool) -> String {
  let mut records = Vec::new();
  records.extend(CONFIG_REGISTRY.iter().filter_map(|descriptor| {
    config_value_at_path(config, descriptor.path).map(|value| build_field_record(descriptor, value, include_values))
  }));
  records.sort_by(|left, right| left.path.cmp(&right.path));

  let mut digest = Sha256::new();
  for record in records {
    digest.update(record.path.as_bytes());
    digest.update(format!("|{:?}|{}|", record.value_type, record.database_writable).as_bytes());
    if include_values {
      if record.sensitive {
        digest.update(if record.value.as_ref().is_some_and(|value| !value.is_null()) {
          b"<sensitive-set>".as_slice()
        } else {
          b"<sensitive-unset>".as_slice()
        });
      } else if let Some(value) = record.value {
        digest.update(value.to_string().as_bytes());
      }
    } else if let Some(value) = record.default_value {
      digest.update(value.to_string().as_bytes());
    }
  }
  format!("{:x}", digest.finalize())
}

fn module_label(module: &str) -> String {
  match module {
    "auth" => "Accounts",
    "branding" => "Design",
    "calendar" => "Calendar",
    "captcha" => "Captcha",
    "client" => "Client",
    "compat" => "Compatibility",
    "copilot" => "Copilot",
    "cors" => "Network",
    "crypto" => "Security",
    "doc" => "Documents",
    "doc_service" => "Document Service",
    "document_graph" => "Document Graph",
    "flags" => "Feature Flags",
    "git_sync" => "Git Sync",
    "i18n" => "Locale",
    "admin_i18n" => "Admin Locale",
    "indexer" => "Search/Indexer",
    "journal" => "Journal",
    "job" => "Queue",
    "logging" => "Logging",
    "mail" => "Mail/Notification",
    "mcp" => "MCP",
    "metrics" => "Metrics",
    "oauth" => "OAuth",
    "server" => "System",
    "storage" => "Storage",
    "template_registry" => "Templates",
    "telemetry" => "Telemetry",
    "throttle" => "Throttling",
    "websocket" => "WebSocket",
    other => other,
  }
  .to_string()
}

fn group_key_for_field(module: &str, path: &str) -> String {
  match (module, path) {
    ("server", _) | ("client", _) | ("compat", _) => "system",
    ("cors", _) | ("websocket", _) | ("throttle", _) => "network",
    ("doc", _) | ("doc_service", _) => "documents",
    ("document_graph", _) => "document-graph",
    ("i18n", _) | ("journal", _) | ("calendar", _) => "locale",
    ("admin_i18n", _) => "admin-locale",
    ("crypto", _) | ("captcha", _) => "security",
    ("flags", _) => "feature-flags",
    ("mail", p) if p.starts_with("fallback_smtp") => "fallback-mail",
    ("mail", _) => "mail",
    ("copilot", p) if p.starts_with("providers") => "providers",
    ("copilot", p) if p.starts_with("unsplash") => "integrations",
    ("copilot", p) if p.starts_with("exa") => "integrations",
    ("copilot", p) if p.starts_with("storage") => "integrations",
    ("copilot", _) => "copilot",
    ("indexer", _) => "search",
    ("mcp", _) => "integrations",
    ("storage", _) => "storage",
    ("auth", p) if p.starts_with("session") => "session",
    ("auth", p) if p.starts_with("password_requirements") => "password",
    ("auth", _) => "auth",
    ("oauth", _) => "oauth",
    ("branding", p) if p.starts_with("theme.") => "theme",
    ("branding", _) => "branding",
    ("git_sync", p) if p.starts_with("mime") => "mime-policy",
    ("git_sync", _) => "git-sync",
    ("job", "queue") => "queue-defaults",
    ("job", "worker") => "worker",
    ("job", p) if p.starts_with("queues.") => "queue-concurrency",
    ("job", _) => "job",
    ("logging", _) => "logging",
    ("template_registry", _) => "templates",
    ("telemetry", _) => "telemetry",
    _ => path.split('.').next().unwrap_or(module),
  }
  .to_string()
}

fn humanize_config_label(input: &str) -> String {
  input
    .split(['.', '_', '-'])
    .filter(|segment| !segment.is_empty())
    .map(humanize_segment)
    .collect::<Vec<_>>()
    .join(" ")
}

fn humanize_segment(segment: &str) -> String {
  match segment {
    "SMTP" => "SMTP".to_string(),
    "URL" => "URL".to_string(),
    "API" => "API".to_string(),
    "OIDC" => "OIDC".to_string(),
    "MCP" => "MCP".to_string(),
    "AI" => "AI".to_string(),
    _ => {
      let mut out = String::new();
      let mut chars = segment.chars().peekable();
      while let Some(ch) = chars.next() {
        if ch.is_uppercase() && !out.is_empty() {
          let next_is_lower = chars.peek().copied().is_some_and(|next| next.is_lowercase());
          let prev_is_lower = out.chars().last().is_some_and(|prev| prev.is_lowercase());
          if prev_is_lower || next_is_lower {
            out.push(' ');
          }
        }
        if out.is_empty() {
          out.push(ch.to_ascii_uppercase());
        } else {
          out.push(ch);
        }
      }
      out.replace("Id", "ID").replace("Url", "URL").replace("Api", "API")
    }
  }
}

/// Load config changelog entries from the database.
///
/// Reads from `admin_audit_log` filtered to `category = 'config'`.
/// The `config_changelog` table is no longer written (P113-AUDIT-C-03).
/// Returns entries ordered by changed_at DESC (newest first).
#[instrument(skip_all)]
pub(crate) async fn load_config_changelog(
  state: &ApiState,
  limit: Option<i32>,
  offset: Option<i32>,
) -> Result<Vec<ConfigChangelogEntryType>> {
  let limit = limit.unwrap_or(50).clamp(1, 500) as i64;
  let offset = offset.unwrap_or(0).max(0) as i64;
  let rows = state
    .audit_recorder()
    .list(
      myoxus_domain::audit::AuditFilter {
        category: Some(myoxus_domain::audit::AuditCategory::Config),
        ..Default::default()
      },
      offset,
      limit,
    )
    .await
    .map_err(|error| async_graphql::Error::new(error.to_string()))?;
  let actor_ids = rows.iter().filter_map(|row| row.actor_user_id).collect::<Vec<_>>();
  let actors = state
    .auth()
    .get_historical_profiles(&actor_ids)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;

  let mut entries = Vec::new();
  for row in rows {
    let config_key = row.target_id.unwrap_or_default();
    let old_value = row.old_value;
    let new_value = row.new_value.unwrap_or(Value::Null);

    // Mask sensitive fields in changelog
    let (old_value, new_value) = if is_sensitive_config_key(&config_key) {
      (
        old_value.map(|_| Value::String("***REDACTED***".to_string())),
        Value::String("***REDACTED***".to_string()),
      )
    } else {
      (old_value, new_value)
    };

    let changed_by: Option<UserType> = row
      .actor_user_id
      .and_then(|user_id| actors.get(&user_id).cloned())
      .map(UserType::from);

    entries.push(ConfigChangelogEntryType {
      id: async_graphql::ID::from(row.id.to_string()),
      config_key,
      old_value,
      new_value,
      changed_by,
      changed_at: row.created_at,
    });
  }

  Ok(entries)
}

/// Records one best-effort configuration audit event.
///
/// Authoritative configuration persistence has already committed when this is
/// called. The shared audit recorder owns failure logging and deliberately does
/// not turn an audit-store outage into a false mutation failure.
#[instrument(skip_all)]
pub(crate) async fn record_config_change(
  state: &ApiState,
  config_key: &str,
  old_value: Option<Value>,
  new_value: Value,
  changed_by: Uuid,
) {
  // D-07: Mask sensitive fields in changelog
  let is_sensitive = is_sensitive_config_key(config_key);
  let log_old_value = if is_sensitive {
    old_value.map(|_| Value::String("***REDACTED***".to_string()))
  } else {
    old_value
  };
  let log_new_value = if is_sensitive {
    Value::String("***REDACTED***".to_string())
  } else {
    new_value
  };

  // P113-AUDIT-C-03: config_changelog INSERT removed — writes go only to admin_audit_log.
  // The audit recorder swallows errors so config writes are never blocked.
  {
    use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
    let event_key = format!("config.{config_key}.update");
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        event_key,
        AuditCategory::Config,
        Some(AuditTarget::config_key(config_key)),
        AuditActor::user(changed_by, None),
        log_old_value,
        Some(log_new_value),
      ))
      .await;
  }
}

/// Records the complete redacted audit projection of one committed batch.
///
/// A removed override is represented by JSON `null`, making set and release
/// operations distinguishable without inventing a second audit event shape.
pub(crate) async fn record_committed_config_changes(
  state: &ApiState,
  changes: &[myoxus_infrastructure::app_config::CommittedConfigChange],
  changed_by: Uuid,
) {
  for change in changes {
    record_config_change(
      state,
      &change.path,
      change.old_value.clone(),
      change.new_value.clone().unwrap_or(Value::Null),
      changed_by,
    )
    .await;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn traversal_stops_on_known_leaf_objects() {
    let config = serde_json::json!({
      "job": {
        "queue": { "attempts": 5 },
        "queues": {
          "copilot": { "concurrency": 10 }
        }
      },
      "server": { "origin": "http://localhost:3001" }
    });

    let paths = admin_config_flattened_paths(&config);
    assert!(paths.contains(&"job.queue".to_string()));
    assert!(paths.contains(&"job.queues.copilot".to_string()));
    assert!(paths.contains(&"server.origin".to_string()));
  }

  #[test]
  fn sensitive_detection_covers_secret_paths() {
    assert!(find_descriptor("mail.smtp_pass").unwrap().sensitive);
    assert!(find_descriptor("oauth.providers.google").unwrap().sensitive);
    assert!(!find_descriptor("server.origin").unwrap().sensitive);
  }

  #[test]
  fn enum_metadata_is_available_for_known_fields() {
    assert_eq!(
      find_descriptor("journal.first_day_of_week").unwrap().enum_values,
      &["monday", "sunday"]
    );
    assert_eq!(
      find_descriptor("git_sync.mime_validation_mode").unwrap().enum_values,
      &["strict", "warn"]
    );
  }

  #[test]
  fn structured_admin_values_never_return_secret_plaintext() {
    let snapshot = build_admin_config_values_snapshot(&serde_json::json!({
      "mail": {
        "smtp_host": "smtp.example",
        "smtp_pass": "must-not-cross"
      }
    }));
    let fields = snapshot
      .modules
      .iter()
      .flat_map(|module| &module.groups)
      .flat_map(|group| &group.fields)
      .collect::<Vec<_>>();
    let host = fields.iter().find(|field| field.path == "mail.smtp_host").unwrap();
    let password = fields.iter().find(|field| field.path == "mail.smtp_pass").unwrap();
    assert_eq!(host.value, Some(serde_json::json!("smtp.example")));
    assert_eq!(
      password.value,
      Some(serde_json::json!(
        myoxus_contracts::effective_config::MASKED_CONFIG_VALUE
      ))
    );
    assert!(!format!("{snapshot:?}").contains("must-not-cross"));
  }

  #[test]
  fn sensitive_object_values_keep_non_secret_shape_and_restore_masked_leaves() {
    let current = serde_json::json!({
      "openai": {
        "enabled": true,
        "endpoint": "https://api.example/v1",
        "api_key": "must-not-cross"
      },
      "oidc": {
        "clientId": "editable-client",
        "clientSecret": "must-not-cross-camel",
        "nested": { "client_secret": "must-not-cross-snake" },
        "groupDirectory": { "clientSecret": "must-not-cross-nested", "token": "must-not-cross-token" }
      }
    });
    let redacted = redact_sensitive_value(&current);
    assert_eq!(redacted["openai"]["enabled"], true);
    assert_eq!(redacted["openai"]["endpoint"], "https://api.example/v1");
    assert_eq!(
      redacted["openai"]["api_key"],
      myoxus_contracts::effective_config::MASKED_CONFIG_VALUE
    );
    assert!(!redacted.to_string().contains("must-not-cross"));
    assert_eq!(redacted["oidc"]["clientId"], "editable-client");

    let mut edited = redacted;
    edited["openai"]["enabled"] = serde_json::json!(false);
    edited["openai"]["endpoint"] = serde_json::json!("https://new.example/v1");
    let restored = restore_masked_value(&edited, &current);
    assert_eq!(restored["openai"]["enabled"], false);
    assert_eq!(restored["openai"]["endpoint"], "https://new.example/v1");
    assert_eq!(restored["openai"]["api_key"], "must-not-cross");
    assert_eq!(restored["oidc"], current["oidc"]);

    edited["oidc"]["clientSecret"] = serde_json::json!("replacement");
    edited["oidc"]["groupDirectory"] = Value::Null;
    let restored = restore_masked_value(&edited, &current);
    assert_eq!(restored["oidc"]["clientSecret"], "replacement");
    assert!(restored["oidc"]["groupDirectory"].is_null());
  }
}

/// Live filesystem projection, distinct from the immutable trust loaded at startup.
#[derive(SimpleObject)]
pub struct AdminCaBundleStatus {
  pub path: Option<String>,
  pub fingerprint: Option<String>,
  pub certificate_count: Option<i32>,
  pub expires_at: Option<DateTime<Utc>>,
  pub file_error: Option<String>,
  pub restriction: Option<String>,
  pub rollback_available: bool,
  pub loaded_snapshot: String,
  pub restart_required: bool,
  pub max_upload_bytes: i32,
}

fn ca_error(error: myoxus_infrastructure::tls::bundle_management::BundleError) -> async_graphql::Error {
  use async_graphql::ErrorExtensions;
  async_graphql::Error::new(error.code).extend_with(|_, extensions| {
    extensions.set("code", error.code);
  })
}

fn ca_projection(
  state: &ApiState,
  status: myoxus_infrastructure::tls::bundle_management::BundleStatus,
) -> AdminCaBundleStatus {
  let loaded = myoxus_infrastructure::tls::snapshot_id(state.config.additional_ca.as_ref());
  let fingerprint = status.metadata.as_ref().map(|metadata| metadata.fingerprint.clone());
  let configured = fingerprint.as_deref().unwrap_or("library-public-roots");
  AdminCaBundleStatus {
    restart_required: status.file_error.is_some()
      || loaded != configured
      || status.path.as_deref()
        != state
          .config
          .tls
          .additional_ca_bundle_path
          .as_deref()
          .map(str::trim)
          .filter(|path| !path.is_empty()),
    path: status.path,
    certificate_count: status
      .metadata
      .as_ref()
      .map(|metadata| metadata.certificate_count as i32),
    expires_at: status.metadata.as_ref().map(|metadata| metadata.expires_at),
    fingerprint,
    file_error: status.file_error.map(str::to_owned),
    restriction: status.restriction.map(str::to_owned),
    rollback_available: status.rollback_available,
    loaded_snapshot: loaded.to_owned(),
    max_upload_bytes: myoxus_infrastructure::tls::bundle_management::MAX_BUNDLE_BYTES as i32,
  }
}

pub(crate) async fn ca_bundle_status(state: &ApiState) -> Result<AdminCaBundleStatus> {
  let status = tokio::task::spawn_blocking(myoxus_infrastructure::tls::bundle_management::inspect)
    .await
    .map_err(|_| "CA_OPERATION_FAILED")?
    .map_err(ca_error)?;
  Ok(ca_projection(state, status))
}

#[instrument(skip_all)]
pub(crate) async fn manage_ca_bundle(
  ctx: &async_graphql::Context<'_>,
  state: &ApiState,
  action: myoxus_infrastructure::tls::bundle_management::BundleAction,
  event: &'static str,
) -> Result<AdminCaBundleStatus> {
  let status = tokio::task::spawn_blocking(move || myoxus_infrastructure::tls::bundle_management::manage(action))
    .await
    .map_err(|_| "CA_OPERATION_FAILED")?
    .map_err(ca_error)?;
  let result = ca_projection(state, status);
  use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
  state
    .audit_recorder()
    .record(AuditEvent::mutation(
      event,
      AuditCategory::Config,
      Some(AuditTarget::config_key("tls.additional_ca_bundle_path")),
      super::admin::resolve_audit_actor(ctx).await,
      None,
      Some(serde_json::json!({"fingerprint": result.fingerprint, "certificateCount": result.certificate_count})),
    ))
    .await;
  Ok(result)
}
