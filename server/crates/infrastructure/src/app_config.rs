// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared persistence access for canonical runtime configuration overrides.

use std::{
  collections::{HashMap, HashSet},
  fs::OpenOptions,
  io::Write,
  path::{Path, PathBuf},
  sync::atomic::{AtomicU64, Ordering},
};

use myoxus_contracts::client_update::CLIENT_UPDATE_CONFIG_KEY;
use myoxus_contracts::{
  effective_config::{CONFIG_REGISTRY, ConfigValueType, find_descriptor, is_nullable_config_path},
  oauth_config::{OAuthProviderConfig, decode_oauth_provider_named, normalize_oauth_provider_source_layer_named},
  runtime_config::resolve_server_config_paths,
};
use sqlx::PgPool;
use thiserror::Error;
use tracing::{debug, warn};
use uuid::Uuid;

use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::config_validation::{PreparedConfigCandidate, StartupConfigValidator};
use myoxus_application::setup::{SetupCompletionChange, SetupStateStore};
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document, encode_config_yaml};

/// Operational setup row that shares `app_configs` without being configuration.
pub const SETUP_COMPLETED_CONFIG_KEY: &str = "system.setupCompleted";
/// Stable warning code for a failed best-effort runtime-overlay mirror.
pub const WRITEBACK_FAILED_WARNING: &str = "CONFIG_WRITEBACK_FAILED";

/// PostgreSQL owner for the operational setup-completion row.
#[derive(Clone)]
pub struct PgSetupStateStore {
  pool: PgPool,
}

impl PgSetupStateStore {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn decode(value: Option<serde_json::Value>) -> AuthResult<Option<bool>> {
    value
      .map(|value| {
        value
          .as_bool()
          .ok_or_else(|| AuthError::Storage(format!("{SETUP_COMPLETED_CONFIG_KEY} contains a non-boolean value")))
      })
      .transpose()
  }
}

#[async_trait::async_trait]
impl SetupStateStore for PgSetupStateStore {
  async fn setup_completed(&self) -> AuthResult<bool> {
    let value = sqlx::query_scalar::<_, serde_json::Value>("SELECT value FROM app_configs WHERE id = $1")
      .bind(SETUP_COMPLETED_CONFIG_KEY)
      .fetch_optional(&self.pool)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    Ok(Self::decode(value)?.unwrap_or(false))
  }

  async fn set_setup_completed(&self, completed: bool, updated_by: Option<Uuid>) -> AuthResult<SetupCompletionChange> {
    let mut transaction = self
      .pool
      .begin()
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let previous = sqlx::query_scalar::<_, serde_json::Value>("SELECT value FROM app_configs WHERE id = $1 FOR UPDATE")
      .bind(SETUP_COMPLETED_CONFIG_KEY)
      .fetch_optional(&mut *transaction)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let previous = Self::decode(previous)?;
    sqlx::query(
      r#"
      INSERT INTO app_configs (id, value, last_updated_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        value = EXCLUDED.value,
        last_updated_by = EXCLUDED.last_updated_by,
        updated_at = now()
      "#,
    )
    .bind(SETUP_COMPLETED_CONFIG_KEY)
    .bind(serde_json::Value::Bool(completed))
    .bind(updated_by)
    .execute(&mut *transaction)
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    transaction
      .commit()
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    Ok(SetupCompletionChange {
      previous,
      current: completed,
    })
  }
}

/// Database-wide serialization key for canonical configuration writes.
///
/// Row locks cannot serialize inserts for paths that do not exist yet. This
/// advisory transaction lock ensures that every transport validates and
/// commits against one coherent `app_configs` snapshot.
const APP_CONFIG_WRITE_LOCK: &str = "myoxus.app_config.write";

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Failure while loading and validating persisted configuration state.
#[derive(Debug, Error)]
pub enum AppConfigLoadError {
  /// PostgreSQL could not return the persisted configuration rows.
  #[error("failed to load app configuration rows: {0}")]
  Database(#[from] sqlx::Error),
  /// A row uses a path that is absent from the canonical registry.
  #[error("unknown app_configs path `{0}`")]
  UnknownPath(String),
  /// A file-owned setting was written to the database out of band.
  #[error("file-only path `{0}` must not be stored in app_configs")]
  FileOnlyPath(String),
  /// A persisted value does not satisfy its descriptor contract.
  #[error("invalid value for `{path}`: {message}")]
  InvalidValue { path: String, message: String },
  /// Individually valid values form an invalid effective configuration.
  #[error("invalid effective configuration: {0}")]
  InvalidCandidate(String),
}

/// One canonical database mutation.
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigMutation {
  /// Create or replace a database override at an exact registry path.
  Set { path: String, value: serde_json::Value },
  /// Delete a database override so the file/default baseline becomes active.
  Remove { path: String },
}

/// Determines whether a batch patches or replaces registered overrides.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigBatchMode {
  /// Change only the paths named by the batch.
  Partial,
  /// Replace all registered database overrides while preserving operational rows.
  ReplaceRegistered,
}

/// A value transition committed by the canonical writer.
#[derive(Clone, Debug, PartialEq)]
pub struct CommittedConfigChange {
  /// Exact path from the canonical configuration registry.
  pub path: String,
  /// Persisted override before the transaction, if one existed.
  pub old_value: Option<serde_json::Value>,
  /// Persisted override after the transaction, if one remains.
  pub new_value: Option<serde_json::Value>,
}

/// Result of the optional operator-owned YAML mirror.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WritebackOutcome {
  /// The mirror was atomically replaced.
  Written,
  /// The mirror already contained all requested values.
  Unchanged,
  /// No runtime-overlay writeback path is configured.
  Disabled,
  /// PostgreSQL committed, but the best-effort mirror could not be updated.
  Failed,
}

impl WritebackOutcome {
  /// Stable transport spelling. It reports only mirror publication; a
  /// `failed` mirror outcome never rewrites an already successful DB commit as
  /// a failed save.
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Written => "written",
      Self::Unchanged => "unchanged",
      Self::Disabled => "disabled",
      Self::Failed => "failed",
    }
  }
}

/// Durable database changes and the independent mirror outcome.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigBatchResult {
  /// Ordered transitions for audit and runtime invalidation.
  pub changes: Vec<CommittedConfigChange>,
  /// Outcome of the optional post-commit YAML mirror.
  pub writeback: WritebackOutcome,
}

/// Side-effect-free result of preparing a batch against one locked database
/// snapshot. CLI dry-run uses the same object that the writer commits.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigBatchPreview {
  pub changes: Vec<CommittedConfigChange>,
  pub requested_sets: usize,
  /// Existing overrides that the prepared partial/full batch would remove.
  pub removals: usize,
}

/// Failure that prevents the canonical writer from committing a batch.
#[derive(Debug, Error)]
pub enum ConfigWriteError {
  /// The requested path is absent from the canonical registry.
  #[error("unknown configuration path `{0}`")]
  UnknownPath(String),
  /// The requested path is intentionally owned by file/secret sources.
  #[error("file-only configuration path `{0}` cannot be persisted")]
  FileOnlyPath(String),
  /// A value or complete candidate violates its registered contract.
  #[error("invalid value for `{path}`: {message}")]
  InvalidValue { path: String, message: String },
  /// Startup sources could not be resolved into a complete candidate.
  #[error("failed to resolve the complete configuration candidate: {0}")]
  Source(String),
  /// An OIDC group mapping points to a missing or inactive organization unit.
  #[error("OIDC group mappings require an active organization unit")]
  InvalidOrganizationUnit,
  /// PostgreSQL rejected or could not complete the transaction.
  #[error("configuration database write failed: {0}")]
  Database(#[from] sqlx::Error),
}

/// Loads every row from the shared `app_configs` table without interpreting ownership.
pub async fn load_app_config_values(pool: &PgPool) -> Result<HashMap<String, serde_json::Value>, sqlx::Error> {
  let rows: Vec<(String, serde_json::Value)> = sqlx::query_as("SELECT id, value FROM app_configs")
    .fetch_all(pool)
    .await?;
  Ok(rows.into_iter().collect())
}

/// Loads only registered database-writable configuration rows. The two
/// operational rows share the table but remain owned by their dedicated
/// setup/client-update services and are excluded before descriptor validation.
pub async fn load_validated_app_config_values(
  pool: &PgPool,
) -> Result<HashMap<String, serde_json::Value>, AppConfigLoadError> {
  let rows = load_app_config_values(pool).await?;
  validate_persisted_config_rows(&rows)
}

fn validate_persisted_config_rows(
  rows: &HashMap<String, serde_json::Value>,
) -> Result<HashMap<String, serde_json::Value>, AppConfigLoadError> {
  // A canonical file/ENV model also shadows the retired DB alias. Ordinary
  // canonical DB overrides retain their existing precedence over file/ENV.
  let canonical_model = if rows.contains_key("copilot.transcription_model") && !rows.contains_key("transcription.model")
  {
    myoxus_contracts::runtime_config::load_server_config_sources()
      .map_err(|_| AppConfigLoadError::InvalidCandidate("configuration sources are unavailable".into()))?
      .explicit_transcription_model
  } else {
    false
  };
  validate_persisted_config_rows_inner(rows, canonical_model)
}

fn validate_persisted_config_rows_inner(
  rows: &HashMap<String, serde_json::Value>,
  canonical_model: bool,
) -> Result<HashMap<String, serde_json::Value>, AppConfigLoadError> {
  let mut values = HashMap::with_capacity(rows.len());
  for (path, value) in rows {
    if path == SETUP_COMPLETED_CONFIG_KEY || path == CLIENT_UPDATE_CONFIG_KEY {
      continue;
    }
    if path == "copilot.transcription_model" {
      if !canonical_model && !rows.contains_key("transcription.model") {
        validate_loaded_config_value("transcription.model", value, true).map_err(|_| {
          AppConfigLoadError::InvalidValue {
            path: path.clone(),
            message: "deprecated transcription model must be a valid model string".into(),
          }
        })?;
        values.insert("transcription.model".into(), value.clone());
      }
      warn!(
        path,
        replacement = "transcription.model",
        "deprecated configuration key read"
      );
      continue;
    }
    let descriptor = find_descriptor(path).ok_or_else(|| AppConfigLoadError::UnknownPath(path.clone()))?;
    if !descriptor.database_writable() && path != "git_sync.https_ca_bundle_path" {
      return Err(AppConfigLoadError::FileOnlyPath(path.clone()));
    }
    validate_loaded_config_value(path, value, true).map_err(|error| match error {
      ConfigWriteError::InvalidValue { path, message } => AppConfigLoadError::InvalidValue { path, message },
      _ => unreachable!("descriptor existence and write policy were checked above"),
    })?;
    values.insert(path.clone(), value.clone());
  }
  Ok(values)
}

/// Applies a validated set/remove batch in one PostgreSQL transaction.
///
/// Full replacement removes only registered configuration rows; operational
/// rows that share `app_configs` remain untouched. The optional YAML mirror
/// runs after commit and resolves the requested reconciliation paths from
/// PostgreSQL while holding both its file lock and the configuration advisory
/// lock. A mirror failure therefore never rolls back the authoritative DB, and
/// concurrent writers cannot leave stale YAML behind.
pub async fn write_config_batch(
  pool: &PgPool,
  mutations: &[ConfigMutation],
  mode: ConfigBatchMode,
  last_updated_by: Option<Uuid>,
  validator: &dyn StartupConfigValidator,
) -> Result<ConfigBatchResult, ConfigWriteError> {
  let mut mutations = normalize_config_mutations(mutations)?;
  let mut tx = pool.begin().await?;
  let prepared = prepare_config_batch_locked(&mut tx, &mutations, mode, validator).await?;
  // Retirement is part of the same validated transaction. Reporting a
  // canonical read projection alone would let removing the new key revive
  // the stale legacy DB row on the next reload.
  for change in &prepared.changes {
    if (change.path == "copilot.transcription_model" || change.path == "transcription.model")
      && !mutations.iter().any(|mutation| match mutation {
        ConfigMutation::Set { path, .. } | ConfigMutation::Remove { path } => *path == change.path,
      })
    {
      mutations.push(match &change.new_value {
        Some(value) => ConfigMutation::Set {
          path: change.path.clone(),
          value: value.clone(),
        },
        None => ConfigMutation::Remove {
          path: change.path.clone(),
        },
      });
    }
  }

  if mode == ConfigBatchMode::ReplaceRegistered {
    let requested_paths = mutations
      .iter()
      .map(|mutation| match mutation {
        ConfigMutation::Set { path, .. } | ConfigMutation::Remove { path } => path.as_str(),
      })
      .collect::<HashSet<_>>();
    for path in prepared.before.keys().filter(|path| {
      find_descriptor(path).is_some_and(|descriptor| descriptor.database_writable())
        && !requested_paths.contains(path.as_str())
    }) {
      sqlx::query("DELETE FROM app_configs WHERE id = $1")
        .bind(path)
        .execute(&mut *tx)
        .await?;
    }
  }
  for mutation in &mutations {
    match mutation {
      ConfigMutation::Set { path, value } => {
        sqlx::query(
          "INSERT INTO app_configs (id, value, last_updated_by, created_at, updated_at) \
           VALUES ($1, $2, $3, now(), now()) \
           ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, \
           last_updated_by = EXCLUDED.last_updated_by, updated_at = now()",
        )
        .bind(path)
        .bind(value)
        .bind(last_updated_by)
        .execute(&mut *tx)
        .await?;
      }
      ConfigMutation::Remove { path } => {
        sqlx::query("DELETE FROM app_configs WHERE id = $1")
          .bind(path)
          .execute(&mut *tx)
          .await?;
      }
    }
  }
  tx.commit().await?;

  let writeback = try_writeback_authoritative(pool, &prepared.intent_paths, validator).await;
  Ok(ConfigBatchResult {
    changes: prepared.changes,
    writeback,
  })
}

/// Prepare and validate a batch without committing it. The transaction lock
/// makes this an exact preview of the observed snapshot, not a reservation of
/// future state; apply repeats preparation under its own lock.
pub async fn preview_config_batch(
  pool: &PgPool,
  mutations: &[ConfigMutation],
  mode: ConfigBatchMode,
  validator: &dyn StartupConfigValidator,
) -> Result<ConfigBatchPreview, ConfigWriteError> {
  let mutations = normalize_config_mutations(mutations)?;
  let mut tx = pool.begin().await?;
  let prepared = prepare_config_batch_locked(&mut tx, &mutations, mode, validator).await?;
  tx.rollback().await?;
  Ok(ConfigBatchPreview {
    removals: prepared
      .changes
      .iter()
      .filter(|change| change.new_value.is_none())
      .count(),
    changes: prepared.changes,
    requested_sets: mutations
      .iter()
      .filter(|mutation| matches!(mutation, ConfigMutation::Set { .. }))
      .count(),
  })
}

struct PreparedBatch {
  before: HashMap<String, serde_json::Value>,
  changes: Vec<CommittedConfigChange>,
  /// Paths the caller intended to reconcile, including idempotent retries.
  /// This is deliberately separate from `changes`: only durable transitions
  /// produce audit events, while unchanged retries may still repair the mirror.
  intent_paths: Vec<String>,
}

async fn prepare_config_batch_locked(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  mutations: &[ConfigMutation],
  mode: ConfigBatchMode,
  validator: &dyn StartupConfigValidator,
) -> Result<PreparedBatch, ConfigWriteError> {
  validate_mutations(mutations)?;
  sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
    .bind(APP_CONFIG_WRITE_LOCK)
    .execute(&mut **tx)
    .await?;
  if mutations.iter().any(is_oidc_provider_mutation) {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
      .bind(crate::organization::ORGANIZATION_LIFECYCLE_LOCK)
      .execute(&mut **tx)
      .await?;
    for mutation in mutations {
      if let ConfigMutation::Set { path, value } = mutation
        && path.starts_with("oauth.providers.")
      {
        let provider_name = path.strip_prefix("oauth.providers.").unwrap_or(path);
        validate_oidc_target_units(tx, provider_name, value).await?;
      }
    }
  }

  let before: HashMap<String, serde_json::Value> =
    sqlx::query_as::<_, (String, serde_json::Value)>("SELECT id, value FROM app_configs FOR UPDATE")
      .fetch_all(&mut **tx)
      .await?
      .into_iter()
      .collect();

  // Validate the locked snapshot before mutating it. Returning an error after
  // commit would misreport durable state and skip transport-level refresh and
  // audit handling.
  let mut candidate_overrides = validate_persisted_config_rows(&before).map_err(ConfigWriteError::from)?;

  let requested_paths = mutations
    .iter()
    .map(|mutation| match mutation {
      ConfigMutation::Set { path, .. } | ConfigMutation::Remove { path } => path.as_str(),
    })
    .collect::<HashSet<_>>();
  if mode == ConfigBatchMode::ReplaceRegistered {
    candidate_overrides.retain(|path, _| requested_paths.contains(path.as_str()));
  }

  for mutation in mutations {
    match mutation {
      ConfigMutation::Set { path, value } => {
        candidate_overrides.insert(path.clone(), value.clone());
      }
      ConfigMutation::Remove { path } => {
        candidate_overrides.remove(path);
      }
    }
  }
  let mut intent_paths = writeback_intent_paths(mode, &requested_paths);
  if before.contains_key("copilot.transcription_model") && candidate_overrides.contains_key("transcription.model") {
    intent_paths.push("transcription.model".into());
    intent_paths.sort();
    intent_paths.dedup();
  }
  let runtime_overlay_yaml = prepare_prospective_overlay(&candidate_overrides, &intent_paths)?;
  validator
    .validate(&PreparedConfigCandidate {
      database_overrides: candidate_overrides.clone(),
      runtime_overlay_yaml,
    })
    .map_err(|message| ConfigWriteError::InvalidValue {
      path: "candidate".to_string(),
      message,
    })?;

  let after = &candidate_overrides;
  let mut paths = before
    .keys()
    .chain(after.keys())
    .filter(|path| find_descriptor(path).is_some() || path.as_str() == "copilot.transcription_model")
    .cloned()
    .collect::<HashSet<_>>()
    .into_iter()
    .collect::<Vec<_>>();
  paths.sort();
  let changes = paths
    .into_iter()
    .filter_map(|path| {
      let old_value = before.get(&path).cloned();
      let new_value = after.get(&path).cloned();
      (old_value != new_value).then_some(CommittedConfigChange {
        path,
        old_value,
        new_value,
      })
    })
    .collect::<Vec<_>>();
  Ok(PreparedBatch {
    before,
    changes,
    intent_paths,
  })
}

fn writeback_intent_paths(mode: ConfigBatchMode, requested_paths: &HashSet<&str>) -> Vec<String> {
  let mut paths = match mode {
    ConfigBatchMode::Partial => requested_paths
      .iter()
      .map(|path| (*path).to_string())
      .collect::<Vec<_>>(),
    // A full import owns the complete registered DB projection. Retaining the
    // complete intent is necessary when a previous mirror attempt failed after
    // DB rows were removed: a same-input retry has no DB diff, but must still
    // remove those stale leaves from the optional runtime overlay.
    ConfigBatchMode::ReplaceRegistered => CONFIG_REGISTRY
      .iter()
      .filter(|descriptor| descriptor.database_writable())
      .map(|descriptor| descriptor.path.to_string())
      .collect::<Vec<_>>(),
  };
  paths.sort();
  paths.dedup();
  paths
}

fn prepare_prospective_overlay(
  candidate_overrides: &HashMap<String, serde_json::Value>,
  intent_paths: &[String],
) -> Result<Option<String>, ConfigWriteError> {
  let Some(path) = writeback_path() else {
    return Ok(None);
  };
  let original = match std::fs::read_to_string(&path) {
    Ok(value) => value,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(_) => return Ok(None),
  };
  let mut document = if original.trim().is_empty() {
    serde_json::json!({})
  } else {
    decode_config_document(&original, ConfigDocumentFormat::Yaml).map_err(|error| ConfigWriteError::InvalidValue {
      path: "runtime_overlay".to_string(),
      message: error.to_string(),
    })?
  };
  for path in intent_paths {
    match candidate_overrides.get(path) {
      Some(value) => set_nested_json(&mut document, path, value.clone()),
      None => remove_nested_json(&mut document, path),
    }
    .map_err(|message| ConfigWriteError::InvalidValue {
      path: path.clone(),
      message,
    })?;
  }
  encode_config_yaml(&document)
    .map(Some)
    .map_err(|_| ConfigWriteError::InvalidValue {
      path: "runtime_overlay".to_string(),
      message: "prospective runtime overlay could not be serialized".to_string(),
    })
}

impl From<AppConfigLoadError> for ConfigWriteError {
  fn from(error: AppConfigLoadError) -> Self {
    match error {
      AppConfigLoadError::Database(error) => Self::Database(error),
      AppConfigLoadError::UnknownPath(path) => Self::UnknownPath(path),
      AppConfigLoadError::FileOnlyPath(path) => Self::FileOnlyPath(path),
      AppConfigLoadError::InvalidValue { path, message } => Self::InvalidValue { path, message },
      AppConfigLoadError::InvalidCandidate(message) => Self::InvalidValue {
        path: "candidate".to_string(),
        message,
      },
    }
  }
}

fn validate_mutations(mutations: &[ConfigMutation]) -> Result<(), ConfigWriteError> {
  let mut seen = HashSet::new();
  for mutation in mutations {
    let (path, value) = match mutation {
      ConfigMutation::Set { path, value } => (path, Some(value)),
      ConfigMutation::Remove { path } => (path, None),
    };
    if !seen.insert(path) {
      return Err(ConfigWriteError::InvalidValue {
        path: path.to_string(),
        message: "a batch may contain each path only once".to_string(),
      });
    }
    let descriptor = find_descriptor(path).ok_or_else(|| ConfigWriteError::UnknownPath(path.clone()))?;
    if !descriptor.database_writable() && !(path == "git_sync.https_ca_bundle_path" && value.is_none()) {
      return Err(ConfigWriteError::FileOnlyPath(path.clone()));
    }
    let Some(value) = value else { continue };
    validate_config_value(path, value)?;
  }
  Ok(())
}

/// Canonicalize deployed aliases at the shared writer boundary. Provider
/// objects stay complete replacements, while the stored DB value, audit value
/// and optional YAML mirror all receive one identical camelCase projection.
fn normalize_config_mutations(mutations: &[ConfigMutation]) -> Result<Vec<ConfigMutation>, ConfigWriteError> {
  mutations
    .iter()
    .map(|mutation| match mutation {
      ConfigMutation::Set { path, value } => {
        let value = if let Some(provider_name) = path.strip_prefix("oauth.providers.") {
          normalize_oauth_provider_source_layer_named(provider_name, value.clone()).map_err(|error| {
            ConfigWriteError::InvalidValue {
              path: path.clone(),
              message: error.to_string(),
            }
          })?
        } else {
          value.clone()
        };
        Ok(ConfigMutation::Set {
          path: path.clone(),
          value,
        })
      }
      ConfigMutation::Remove { path } => Ok(ConfigMutation::Remove { path: path.clone() }),
    })
    .collect()
}

/// Validate one canonical value independently of its transport. The loader and
/// every writer call this function so malformed out-of-band rows cannot become
/// an alternate effective configuration contract.
pub fn validate_config_value(path: &str, value: &serde_json::Value) -> Result<(), ConfigWriteError> {
  let descriptor = find_descriptor(path).ok_or_else(|| ConfigWriteError::UnknownPath(path.to_string()))?;
  if !descriptor.database_writable() {
    return Err(ConfigWriteError::FileOnlyPath(path.to_string()));
  }
  validate_loaded_config_value(path, value, false)
}

// Deployed Git-only DB values remain readable/removable, but cannot be written
// again or promoted to global trust after PostgreSQL has already connected.
fn validate_loaded_config_value(
  path: &str,
  value: &serde_json::Value,
  allow_legacy_normalization: bool,
) -> Result<(), ConfigWriteError> {
  let descriptor = find_descriptor(path).ok_or_else(|| ConfigWriteError::UnknownPath(path.to_string()))?;
  if value.is_null() {
    if is_nullable_config_path(path) {
      return Ok(());
    }
    return Err(ConfigWriteError::InvalidValue {
      path: path.to_string(),
      message: "null is not valid for this configuration path; use remove to release the override".to_string(),
    });
  }
  let type_matches = match descriptor.value_type {
    ConfigValueType::Boolean => value.is_boolean(),
    ConfigValueType::Number => value.is_number(),
    ConfigValueType::String => value.is_string(),
    ConfigValueType::Object => value.is_object(),
    ConfigValueType::Array => value.is_array(),
  };
  if !type_matches {
    return Err(ConfigWriteError::InvalidValue {
      path: path.to_string(),
      message: format!("expected {}", descriptor.value_type.label()),
    });
  }
  if allow_legacy_normalization
    && path == "doc.history.interval"
    && value.as_i64().is_some_and(|interval| (1..900_000).contains(&interval))
  {
    return Ok(());
  }
  if let Some(number) = value.as_i64() {
    if descriptor.min_value.is_some_and(|minimum| number < minimum)
      || descriptor.max_value.is_some_and(|maximum| number > maximum)
    {
      return Err(ConfigWriteError::InvalidValue {
        path: path.to_string(),
        message: "numeric value is outside the registered bounds".to_string(),
      });
    }
  } else if value.is_number()
    && (descriptor.min_value.is_some()
      || descriptor.max_value.is_some()
      || value.as_f64().is_none_or(|number| !number.is_finite()))
  {
    return Err(ConfigWriteError::InvalidValue {
      path: path.to_string(),
      message: "numeric value must be a finite number compatible with the registered bounds".to_string(),
    });
  }
  if !descriptor.enum_values.is_empty()
    && value
      .as_str()
      .is_none_or(|candidate| !descriptor.enum_values.contains(&candidate))
  {
    return Err(ConfigWriteError::InvalidValue {
      path: path.to_string(),
      message: "value is not in the registered enum".to_string(),
    });
  }
  let (module, key) = path.split_once('.').unwrap_or(("", path));
  if let Some(message) = crate::app_config_validation::validate_config_value_shape(module, key, value) {
    return Err(ConfigWriteError::InvalidValue {
      path: path.to_string(),
      message,
    });
  }
  Ok(())
}

fn is_oidc_provider_mutation(mutation: &ConfigMutation) -> bool {
  matches!(mutation, ConfigMutation::Set { path, .. } if path.starts_with("oauth.providers."))
}

async fn validate_oidc_target_units(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  provider_name: &str,
  provider: &serde_json::Value,
) -> Result<(), ConfigWriteError> {
  let OAuthProviderConfig::Custom(provider) =
    decode_oauth_provider_named(provider_name, provider.clone()).map_err(|error| ConfigWriteError::InvalidValue {
      path: "oauth.providers".to_string(),
      message: error.to_string(),
    })?
  else {
    return Ok(());
  };
  for mapping in &provider.group_mapping.mappings {
    let target = Uuid::parse_str(&mapping.target_unit_id).map_err(|_| ConfigWriteError::InvalidOrganizationUnit)?;
    let active = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM organization_unit WHERE id = $1 AND status = 'active' FOR KEY SHARE",
    )
    .bind(target)
    .fetch_optional(&mut **tx)
    .await?;
    if active.is_none() {
      return Err(ConfigWriteError::InvalidOrganizationUnit);
    }
  }
  Ok(())
}

/// Returns the explicitly configured runtime-overlay writeback target.
pub fn writeback_path() -> Option<PathBuf> {
  resolve_server_config_paths().writeback_path
}

/// Applies direct startup-owned values to the optional runtime overlay.
///
/// Runtime database mutations must use [`write_config_batch`], which mirrors
/// the authoritative post-commit PostgreSQL state instead of caller values.
pub fn try_writeback(updates: &[(String, serde_json::Value)]) -> WritebackOutcome {
  let Some(path) = writeback_path() else {
    return WritebackOutcome::Disabled;
  };
  try_writeback_to(&path, updates)
}

fn try_writeback_to(path: &Path, updates: &[(String, serde_json::Value)]) -> WritebackOutcome {
  let changes = updates
    .iter()
    .map(|(path, value)| (path.clone(), Some(value.clone())))
    .collect::<Vec<_>>();
  try_writeback_changes_to(path, &changes)
}

async fn try_writeback_authoritative(
  pool: &PgPool,
  paths: &[String],
  validator: &dyn StartupConfigValidator,
) -> WritebackOutcome {
  let Some(path) = writeback_path() else {
    return WritebackOutcome::Disabled;
  };
  if paths.is_empty() {
    return WritebackOutcome::Unchanged;
  }
  let _file_lock = match acquire_writeback_lock(&path) {
    Ok(lock) => lock,
    Err(error) => {
      warn_writeback_failure("lock", error.kind());
      return WritebackOutcome::Failed;
    }
  };
  // The canonical writer never waits for the file lock while holding the DB
  // lock: it commits first. The mirror may therefore take the locks in this
  // order without forming a cycle. Holding both while re-reading and publishing
  // prevents a newer DB commit from making the validated YAML candidate stale.
  let mut tx = match pool.begin().await {
    Ok(tx) => tx,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  if let Err(error) = sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
    .bind(APP_CONFIG_WRITE_LOCK)
    .execute(&mut *tx)
    .await
  {
    warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
    return WritebackOutcome::Failed;
  }
  let rows = match sqlx::query_as::<_, (String, serde_json::Value)>("SELECT id, value FROM app_configs")
    .fetch_all(&mut *tx)
    .await
  {
    Ok(rows) => rows.into_iter().collect::<HashMap<_, _>>(),
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  let current = match validate_persisted_config_rows(&rows) {
    Ok(values) => values,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };

  let original = match std::fs::read_to_string(&path) {
    Ok(value) => value,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(error) => {
      warn_writeback_failure("read", error.kind());
      return WritebackOutcome::Failed;
    }
  };
  let original_document = match decode_writeback_document(&original) {
    Ok(document) => document,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  let mut document = original_document.clone();
  for intent_path in paths {
    let result = match current.get(intent_path) {
      Some(value) => set_nested_json(&mut document, intent_path, value.clone()),
      None => remove_nested_json(&mut document, intent_path),
    };
    if let Err(error) = result {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, path = %intent_path, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  }
  let yaml = match encode_config_yaml(&document) {
    Ok(value) => value,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  if let Err(message) = validator.validate(&PreparedConfigCandidate {
    database_overrides: current,
    runtime_overlay_yaml: Some(yaml.clone()),
  }) {
    warn!(warning_code = WRITEBACK_FAILED_WARNING, error = %message, "runtime config YAML mirror failed validation");
    return WritebackOutcome::Failed;
  }
  if original_document == document {
    return WritebackOutcome::Unchanged;
  }
  match write_yaml_atomic_observed(&path, &yaml) {
    Ok(()) => {
      debug!(updated = paths.len(), "runtime config YAML mirror written");
      WritebackOutcome::Written
    }
    Err(error) => {
      warn!(
        warning_code = WRITEBACK_FAILED_WARNING,
        stage = error.stage,
        published = error.published,
        error_kind = ?error.source.kind(),
        "runtime config YAML mirror failed"
      );
      WritebackOutcome::Failed
    }
  }
}

pub(crate) fn decode_writeback_document(original: &str) -> Result<serde_json::Value, String> {
  if original.trim().is_empty() {
    Ok(serde_json::json!({}))
  } else {
    decode_config_document(original, ConfigDocumentFormat::Yaml).map_err(|error| error.to_string())
  }
}

fn try_writeback_changes_to(path: &Path, changes: &[(String, Option<serde_json::Value>)]) -> WritebackOutcome {
  let lock = match acquire_writeback_lock(path) {
    Ok(lock) => lock,
    Err(error) => {
      warn_writeback_failure("lock", error.kind());
      return WritebackOutcome::Failed;
    }
  };
  try_writeback_changes_to_locked(path, changes, lock)
}

fn try_writeback_changes_to_locked(
  path: &Path,
  changes: &[(String, Option<serde_json::Value>)],
  _lock: std::fs::File,
) -> WritebackOutcome {
  let original = match std::fs::read_to_string(path) {
    Ok(value) => value,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(error) => {
      warn_writeback_failure("read", error.kind());
      return WritebackOutcome::Failed;
    }
  };
  let mut document = match decode_writeback_document(&original) {
    Ok(value) => value,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  for (path, value) in changes {
    let result = match value {
      Some(value) => set_nested_json(&mut document, path, value.clone()),
      None => remove_nested_json(&mut document, path),
    };
    if let Err(error) = result {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  }
  let original_value = decode_writeback_document(&original).unwrap_or_else(|_| serde_json::json!({}));
  if original_value == document {
    return WritebackOutcome::Unchanged;
  }
  let yaml = match encode_config_yaml(&document) {
    Ok(value) => value,
    Err(error) => {
      warn!(warning_code = WRITEBACK_FAILED_WARNING, %error, "runtime config YAML mirror failed");
      return WritebackOutcome::Failed;
    }
  };
  match write_yaml_atomic_observed(path, &yaml) {
    Ok(()) => {
      debug!(updated = changes.len(), "runtime config YAML mirror written");
      WritebackOutcome::Written
    }
    Err(error) => {
      warn!(
        warning_code = WRITEBACK_FAILED_WARNING,
        stage = error.stage,
        published = error.published,
        error_kind = ?error.source.kind(),
        "runtime config YAML mirror failed"
      );
      WritebackOutcome::Failed
    }
  }
}

/// Atomically replaces one YAML file and fsyncs both file and parent directory.
pub fn write_yaml_atomic(path: &Path, yaml: &str) -> std::io::Result<()> {
  write_yaml_atomic_observed(path, yaml).map_err(|error| error.source)
}

pub(crate) struct AtomicYamlWriteError {
  pub(crate) source: std::io::Error,
  stage: &'static str,
  /// `true` once rename made the candidate visible. A later directory-fsync
  /// failure means publication was observed but crash durability is uncertain;
  /// callers must not claim that the previous file was retained.
  pub(crate) published: bool,
}

fn write_yaml_atomic_observed(path: &Path, yaml: &str) -> Result<(), AtomicYamlWriteError> {
  write_bytes_atomic(path, yaml.as_bytes())
}

pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), AtomicYamlWriteError> {
  write_bytes_atomic_with_permissions(path, bytes, None)
}

pub(crate) fn write_bytes_atomic_with_permissions(
  path: &Path,
  bytes: &[u8],
  permissions: Option<std::fs::Permissions>,
) -> Result<(), AtomicYamlWriteError> {
  let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("local.yaml");
  let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
  let temp_path = path.with_file_name(format!(".{file_name}.tmp.{}.{}", std::process::id(), sequence));
  #[cfg(unix)]
  use std::os::unix::fs::OpenOptionsExt;
  let result = (|| {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp_path).map_err(|source| AtomicYamlWriteError {
      source,
      stage: "create_temp",
      published: false,
    })?;
    file.write_all(bytes).map_err(|source| AtomicYamlWriteError {
      source,
      stage: "write_temp",
      published: false,
    })?;
    if let Some(permissions) = permissions {
      file
        .set_permissions(permissions)
        .map_err(|source| AtomicYamlWriteError {
          source,
          stage: "set_permissions",
          published: false,
        })?;
    }
    file.sync_all().map_err(|source| AtomicYamlWriteError {
      source,
      stage: "fsync_temp",
      published: false,
    })?;
    std::fs::rename(&temp_path, path).map_err(|source| AtomicYamlWriteError {
      source,
      stage: "rename",
      published: false,
    })?;
    if let Some(parent) = path.parent() {
      std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| AtomicYamlWriteError {
          source,
          stage: "fsync_parent",
          published: true,
        })?;
    }
    Ok(())
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&temp_path);
  }
  result
}

fn acquire_writeback_lock(path: &Path) -> std::io::Result<std::fs::File> {
  use fs2::FileExt;
  #[cfg(unix)]
  use std::os::unix::fs::OpenOptionsExt;
  let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("local.yaml");
  let lock_path = path.with_file_name(format!(".{file_name}.lock"));
  let mut options = OpenOptions::new();
  options.read(true).write(true).create(true);
  #[cfg(unix)]
  options.mode(0o600);
  let file = options.open(lock_path)?;
  file.lock_exclusive()?;
  Ok(file)
}

/// CA administration shares the YAML writer lock, but never waits indefinitely.
pub(crate) fn acquire_writeback_lock_bounded(path: &Path) -> std::io::Result<std::fs::File> {
  use fs2::FileExt;
  let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("local.yaml");
  let mut options = OpenOptions::new();
  options.read(true).write(true).create(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let file = options.open(path.with_file_name(format!(".{name}.lock")))?;
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
  loop {
    match file.try_lock_exclusive() {
      Ok(()) => return Ok(file),
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => {
        std::thread::sleep(std::time::Duration::from_millis(25))
      }
      Err(error) => return Err(error),
    }
  }
}

pub(crate) fn set_nested_json(
  root: &mut serde_json::Value,
  path: &str,
  value: serde_json::Value,
) -> Result<(), String> {
  let mut segments = path.splitn(2, '.');
  let head = segments
    .next()
    .filter(|segment| !segment.is_empty())
    .ok_or("empty config path")?;
  let object = root
    .as_object_mut()
    .ok_or_else(|| format!("config parent for `{path}` is not an object"))?;
  if let Some(tail) = segments.next() {
    let child = object.entry(head.to_string()).or_insert_with(|| serde_json::json!({}));
    set_nested_json(child, tail, value)
  } else {
    object.insert(head.to_string(), value);
    Ok(())
  }
}

fn remove_nested_json(root: &mut serde_json::Value, path: &str) -> Result<(), String> {
  let (head, tail) = path.split_once('.').unwrap_or((path, ""));
  if head.is_empty() {
    return Err("empty config path".to_string());
  }
  let object = root
    .as_object_mut()
    .ok_or_else(|| format!("config parent for `{path}` is not an object"))?;
  if tail.is_empty() {
    object.remove(head);
    return Ok(());
  }
  let Some(child) = object.get_mut(head) else {
    return Ok(());
  };
  remove_nested_json(child, tail)?;
  if child.as_object().is_some_and(serde_json::Map::is_empty) {
    object.remove(head);
  }
  Ok(())
}

fn warn_writeback_failure(stage: &'static str, error_kind: std::io::ErrorKind) {
  warn!(
    warning_code = WRITEBACK_FAILED_WARNING,
    stage,
    ?error_kind,
    "runtime config YAML mirror failed"
  );
}

#[cfg(test)]
mod tests {

  #[test]
  fn speech_config_rejects_embedded_credentials_and_fractional_limits() {
    for endpoint in [
      "http://user:do-not-echo-this-secret@host/v1",
      "https://host/v1?api_key=do-not-echo-this-secret",
      "file:///tmp/stt",
      "http://host/v1/audio/transcriptions",
    ] {
      let error = super::validate_config_value("transcription.endpoint", &serde_json::json!(endpoint))
        .unwrap_err()
        .to_string();
      assert!(!error.contains("do-not-echo-this-secret"));
    }
    assert!(
      super::validate_config_value(
        "transcription.endpoint",
        &serde_json::json!("http://internal-host:8000/v1")
      )
      .is_ok()
    );
    assert!(super::validate_config_value("transcription.max_concurrency", &serde_json::json!(0)).is_err());
    assert!(super::validate_config_value("transcription.max_concurrency", &serde_json::json!(1.5)).is_err());
    assert!(super::validate_config_value("transcription.api_key", &serde_json::Value::Null).is_ok());
  }

  use super::*;

  #[test]
  fn legacy_git_ca_is_readable_and_removable_but_never_writable() {
    let key = "git_sync.https_ca_bundle_path";
    let value = serde_json::json!("ca/company.pem");
    let rows = HashMap::from([(key.to_string(), value.clone())]);
    assert_eq!(validate_persisted_config_rows(&rows).unwrap(), rows);
    assert!(validate_config_value(key, &value).is_err());
    assert!(validate_mutations(&[ConfigMutation::Remove { path: key.to_string() }]).is_ok());
    let global_rows = HashMap::from([("tls.additional_ca_bundle_path".to_string(), value)]);
    assert!(matches!(
      validate_persisted_config_rows(&global_rows),
      Err(AppConfigLoadError::FileOnlyPath(_))
    ));
  }

  #[test]
  fn canonical_validator_rejects_structured_values_for_every_transport() {
    for (path, value) in [
      ("metrics.categories", serde_json::json!({"auth": "yes"})),
      ("telemetry.sampling_rates", serde_json::json!({"page_view": 1.5})),
      ("job.queues.doc", serde_json::json!({"concurrency": "four"})),
      (
        "oauth.providers.oidc",
        serde_json::json!({"clientId": "id", "clientSecret": "secret"}),
      ),
    ] {
      assert!(
        matches!(
          validate_config_value(path, &value),
          Err(ConfigWriteError::InvalidValue { .. })
        ),
        "{path} must fail before any transport can persist it"
      );
    }
  }

  #[test]
  fn canonical_validator_preserves_registered_fractional_pdf_scales() {
    assert!(validate_config_value("pdf_export.heading_font_scale", &serde_json::json!(1.25)).is_ok());
    assert!(validate_config_value("pdf_export.body_font_scale", &serde_json::json!(0.75)).is_ok());
    assert!(validate_config_value("pdf_export.body_font_scale", &serde_json::json!(2.0)).is_err());
  }

  #[test]
  fn canonical_validator_enforces_integral_bounds() {
    assert!(validate_config_value("logging.max_history", &serde_json::json!(0.5)).is_err());
    assert!(validate_config_value("git_sync.clone_depth", &serde_json::json!(0.5)).is_err());
    for value in [
      serde_json::json!(0),
      serde_json::json!(31),
      serde_json::json!(1.5),
      serde_json::Value::Null,
    ] {
      assert!(validate_config_value("git_sync.retention_days", &value).is_err());
    }
    for days in [1, 30] {
      assert!(validate_config_value("git_sync.retention_days", &serde_json::json!(days)).is_ok());
    }
  }

  #[test]
  fn canonical_validator_rejects_non_public_literal_url_hosts() {
    for endpoint in [
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "http://[::ffff:127.0.0.1]:8080",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1",
      "http://198.18.0.1",
      "http://[2001:db8::1]",
    ] {
      assert!(
        validate_config_value("doc_service.endpoint", &serde_json::json!(endpoint)).is_err(),
        "non-public literal endpoint must be rejected: {endpoint}"
      );
    }
    assert!(
      validate_config_value(
        "doc_service.endpoint",
        &serde_json::json!("https://doc-service.example.test")
      )
      .is_ok()
    );
  }

  #[test]
  fn writeback_atomically_merges_canonical_paths_and_preserves_unrelated_values() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("local.yaml");
    std::fs::write(&path, "server:\n  name: Existing\nstorage:\n  root: /data\n").expect("initial YAML");

    assert_eq!(
      try_writeback_to(
        &path,
        &[
          ("server.name".to_string(), serde_json::json!("Updated")),
          ("server.port".to_string(), serde_json::json!(3001)),
        ],
      ),
      WritebackOutcome::Written
    );
    let value: serde_json::Value = decode_config_document(
      &std::fs::read_to_string(&path).expect("written YAML"),
      ConfigDocumentFormat::Yaml,
    )
    .expect("parse YAML");
    assert_eq!(value["server"]["name"], "Updated");
    assert_eq!(value["server"]["port"], 3001);
    assert_eq!(value["storage"]["root"], "/data");
    assert!(std::fs::read_dir(dir.path()).expect("overlay directory").all(|entry| {
      !entry
        .expect("directory entry")
        .file_name()
        .to_string_lossy()
        .contains(".tmp.")
    }));
  }

  #[test]
  fn invalid_overlay_fails_closed_without_replacing_operator_content() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("local.yaml");
    let invalid = "server: [operator-content\n";
    std::fs::write(&path, invalid).expect("invalid YAML fixture");

    assert_eq!(
      try_writeback_to(
        &path,
        &[("server.name".to_string(), serde_json::json!("must-not-replace"))]
      ),
      WritebackOutcome::Failed
    );
    assert_eq!(std::fs::read_to_string(&path).expect("preserved YAML"), invalid);
  }

  #[test]
  fn removing_a_database_override_removes_only_its_runtime_overlay_leaf() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("local.yaml");
    std::fs::write(
      &path,
      "server:\n  name: Mirrored\n  port: 3001\nstorage:\n  root: /data\n",
    )
    .expect("initial YAML");

    assert_eq!(
      try_writeback_changes_to(&path, &[("server.name".to_string(), None)]),
      WritebackOutcome::Written
    );
    let value: serde_json::Value = decode_config_document(
      &std::fs::read_to_string(&path).expect("written YAML"),
      ConfigDocumentFormat::Yaml,
    )
    .expect("parse YAML");
    assert!(value["server"].get("name").is_none());
    assert_eq!(value["server"]["port"], 3001);
    assert_eq!(value["storage"]["root"], "/data");
  }

  #[test]
  fn writeback_intent_survives_idempotent_partial_and_full_retries() {
    let partial = HashSet::from(["server.name"]);
    assert_eq!(
      writeback_intent_paths(ConfigBatchMode::Partial, &partial),
      vec!["server.name"]
    );

    let full = writeback_intent_paths(ConfigBatchMode::ReplaceRegistered, &HashSet::new());
    assert!(full.contains(&"server.name".to_string()));
    assert!(full.contains(&"oauth.providers.oidc".to_string()));
    assert!(!full.contains(&SETUP_COMPLETED_CONFIG_KEY.to_string()));
    assert!(!full.contains(&CLIENT_UPDATE_CONFIG_KEY.to_string()));
  }

  #[test]
  fn concurrent_writebacks_preserve_disjoint_updates() {
    use std::sync::{Arc, Barrier};

    const WRITERS: usize = 8;
    let dir = tempfile::tempdir().expect("tempdir");
    let path = Arc::new(dir.path().join("local.yaml"));
    std::fs::write(path.as_ref(), "{}\n").expect("initial YAML");
    let barrier = Arc::new(Barrier::new(WRITERS));
    let threads = (0..WRITERS)
      .map(|index| {
        let path = Arc::clone(&path);
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
          barrier.wait();
          try_writeback_to(
            path.as_ref(),
            &[(format!("concurrent.writer_{index}"), serde_json::json!(index))],
          )
        })
      })
      .collect::<Vec<_>>();
    for thread in threads {
      assert_eq!(thread.join().expect("writeback thread"), WritebackOutcome::Written);
    }
    let value: serde_json::Value = decode_config_document(
      &std::fs::read_to_string(path.as_ref()).expect("written YAML"),
      ConfigDocumentFormat::Yaml,
    )
    .expect("parse YAML");
    for index in 0..WRITERS {
      assert_eq!(value["concurrent"][format!("writer_{index}")], index);
    }
  }
}
