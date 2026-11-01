//! SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! Admin configuration export/import endpoints (P91-CFG-B).
//!
//! - `GET /api/admin/config/export` — export current config as YAML
//! - `POST /api/admin/config/import` — import config from YAML

use axum::{
  Json,
  extract::{Query, State},
  http::{HeaderMap, StatusCode},
  response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use tracing::{debug, info, instrument, warn};

use crate::config::StorageBackend;
use crate::graphql::UpdateAppConfigInput;
use crate::graphql::config::validate_update;
use crate::state::ApiState;
use myoxus_contracts::effective_config::{CONFIG_REGISTRY, MASKED_CONFIG_VALUE, find_descriptor};

/// Query parameters for config export.
#[derive(Debug, Deserialize)]
pub struct ExportQuery {
  /// Kept only for request compatibility. Secret export is intentionally
  /// unsupported; sensitive values are always masked.
  #[serde(default)]
  include_secrets: bool,
}

/// Query parameters for config import.
#[derive(Debug, Deserialize)]
pub struct ImportQuery {
  /// Import mode: "partial" (upsert) or "full" (replace all).
  #[serde(default = "default_import_mode")]
  mode: String,
}

fn default_import_mode() -> String {
  "partial".to_string()
}

/// Response body for config import result.
#[derive(Debug, Serialize)]
pub struct ImportResult {
  /// Number of keys successfully imported.
  imported: usize,
  /// Optional runtime-overlay publication outcome. `failed` means the DB
  /// commit succeeded and an operator may safely repeat the same import.
  writeback: Option<&'static str>,
  /// List of validation errors (if any).
  errors: Vec<ImportError>,
}

/// Single validation error during import.
#[derive(Debug, Serialize)]
pub struct ImportError {
  /// Config key (e.g. "job.queues.copilot.concurrency").
  key: String,
  /// Error message.
  message: String,
}

/// Apply the irreversible export representation after classification by the
/// shared effective-config sensitivity policy.
fn mask_value(_key: &str, _value: &serde_json::Value) -> serde_json::Value {
  json!(MASKED_CONFIG_VALUE)
}

/// `GET /api/admin/config/export` — Export configuration as flat dot-notation JSON.
///
/// Iterates over `CONFIG_REGISTRY`, resolves the startup and database
/// projection, and always masks sensitive fields. The historical
/// `include_secrets` query parameter cannot disable masking.
#[instrument(skip_all, level = "debug")]
pub async fn export_config(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Query(params): Query<ExportQuery>,
) -> impl IntoResponse {
  debug!("export_config endpoint called");
  let _ = params.include_secrets;

  // Require admin auth.
  if let Err(status) = crate::require_admin_user(&state, &headers).await {
    return status.into_response();
  }

  // Resolve the same startup + DB projection as the structured Admin API.
  let full_json = match crate::graphql::admin_config::load_admin_config_json(&state).await {
    Ok(config) => config,
    Err(error) => {
      warn!(error = ?error, "config export resolution failed");
      return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
  };

  // Build a flat dot-notation map by looking up each registry entry in the nested JSON.
  let mut config_map: HashMap<String, serde_json::Value> = HashMap::new();

  for entry in CONFIG_REGISTRY.iter() {
    let (module, key) = entry.module_and_key();
    let dot_key = entry.path.to_string();

    // Navigate the nested JSON: module → key (which may itself be dot-separated).
    // e.g. module="server", key="externalUrl" → full_json["server"]["externalUrl"]
    // e.g. module="client", key="versionControl.enabled" → full_json["client"]["versionControl"]["enabled"]
    let module_obj = &full_json[module];
    if module_obj.is_null() {
      continue;
    }

    let value = resolve_nested_key(module_obj, key);
    if value.is_null() {
      continue;
    }

    // The export boundary never returns secret plaintext, including to admins.
    if entry.sensitive {
      let masked = mask_value(&dot_key, value);
      config_map.insert(dot_key, masked);
    } else {
      config_map.insert(dot_key, value.clone());
    }
  }

  debug!(keys = config_map.len(), masked = true, "config export complete");

  Json(config_map).into_response()
}

/// Resolve a possibly dot-separated key path within a JSON value.
///
/// For example, `resolve_nested_key(obj, "versionControl.enabled")` walks
/// `obj["versionControl"]["enabled"]`.
fn resolve_nested_key<'a>(root: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
  let mut current = root;
  for segment in key.split('.') {
    current = &current[segment];
    if current.is_null() {
      return current;
    }
  }
  current
}

/// Request body for config import.
#[derive(Debug)]
pub struct ImportRequest {
  /// Flat config map with dot-notation keys (e.g. "job.queues.copilot.concurrency").
  config: HashMap<String, serde_json::Value>,
}

impl<'de> Deserialize<'de> for ImportRequest {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let value = myoxus_contracts::config_document::StrictConfigValue::deserialize(deserializer)?.into_value();
    let mut object = value
      .as_object()
      .cloned()
      .ok_or_else(|| serde::de::Error::custom("config import request must be an object"))?;
    let config = object
      .remove("config")
      .ok_or_else(|| serde::de::Error::missing_field("config"))?;
    if let Some(field) = object.keys().next() {
      return Err(serde::de::Error::unknown_field(field, &["config"]));
    }
    let config = config
      .as_object()
      .cloned()
      .ok_or_else(|| serde::de::Error::custom("config must be an object"))?
      .into_iter()
      .collect();
    Ok(Self { config })
  }
}

/// `POST /api/admin/config/import` — Import configuration into app_configs table.
///
/// Validates all keys and persists them to database.
/// Returns list of imported keys and any validation errors.
///
/// Modes:
/// - "partial" (default): upsert only provided keys
/// - "full": delete all existing keys not in the import (reset to defaults)
#[instrument(skip_all, level = "debug")]
pub async fn import_config(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Query(params): Query<ImportQuery>,
  Json(req): Json<ImportRequest>,
) -> impl IntoResponse {
  debug!(
    keys = req.config.len(),
    mode = params.mode,
    "import_config endpoint called"
  );

  // Require admin auth.
  let admin_user_id = match crate::require_admin_user(&state, &headers).await {
    Ok(id) => id,
    Err(status) => return status.into_response(),
  };

  // Get database pool
  let pool = match state.metrics_pool() {
    Some(p) => p.clone(),
    None => {
      warn!("metrics_pool not available for config import");
      return (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ImportResult {
          imported: 0,
          writeback: None,
          errors: vec![ImportError {
            key: "".to_string(),
            message: "database pool unavailable".to_string(),
          }],
        }),
      )
        .into_response();
    }
  };

  // First pass: validate all keys
  let mut errors: Vec<ImportError> = Vec::new();
  let mut valid_pairs: Vec<(String, serde_json::Value)> = Vec::new();
  let mut null_deletions: Vec<String> = Vec::new();

  for (key, value) in req.config.iter() {
    // Basic validation: key must not be empty
    if key.is_empty() {
      errors.push(ImportError {
        key: key.clone(),
        message: "key cannot be empty".to_string(),
      });
      continue;
    }

    // Structural validation: ensure key follows dot-notation pattern
    if !key
      .chars()
      .all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
      errors.push(ImportError {
        key: key.clone(),
        message: "invalid character in key".to_string(),
      });
      continue;
    }

    let Some(descriptor) = find_descriptor(key) else {
      errors.push(ImportError {
        key: key.clone(),
        message: format!("unknown config key {key}"),
      });
      continue;
    };
    if !descriptor.database_writable() {
      errors.push(ImportError {
        key: key.clone(),
        message: format!("{key} is configured through YAML, environment, or a secret file only"),
      });
      continue;
    }

    // Null value means removal for import, unlike a nullable mutation set.
    if value.is_null() {
      null_deletions.push(key.clone());
      continue;
    }

    // Type and range validation: split dot-notation key into module + subkey
    // and reuse the same validate_update() logic as adminUpdateConfig.
    let (module, subkey) = match key.splitn(2, '.').collect::<Vec<_>>().as_slice() {
      [m, k] => (m.to_string(), k.to_string()),
      [m] => (m.to_string(), String::new()),
      _ => (key.clone(), String::new()),
    };
    let result = validate_update(UpdateAppConfigInput {
      module: module.clone(),
      key: subkey.clone(),
      value: Some(value.clone()),
    });
    if !result.valid {
      errors.push(ImportError {
        key: key.clone(),
        message: result.error.unwrap_or_else(|| "invalid value".to_string()),
      });
      continue;
    }
    valid_pairs.push((key.clone(), value.clone()));
  }

  // If there are validation errors, return early without persisting
  if !errors.is_empty() {
    warn!(
      valid = valid_pairs.len(),
      errors = errors.len(),
      "config import validation failed"
    );
    return (
      StatusCode::BAD_REQUEST,
      Json(ImportResult {
        imported: 0,
        writeback: None,
        errors,
      }),
    )
      .into_response();
  }

  // Second pass: persist to database in a transaction
  let mode = if params.mode == "full" {
    myoxus_infrastructure::app_config::ConfigBatchMode::ReplaceRegistered
  } else if params.mode == "partial" {
    myoxus_infrastructure::app_config::ConfigBatchMode::Partial
  } else {
    return (
      StatusCode::BAD_REQUEST,
      Json(ImportResult {
        imported: 0,
        writeback: None,
        errors: vec![ImportError {
          key: String::new(),
          message: "mode must be partial or full".to_string(),
        }],
      }),
    )
      .into_response();
  };
  let mutations = valid_pairs
    .iter()
    .map(|(path, value)| myoxus_infrastructure::app_config::ConfigMutation::Set {
      path: path.clone(),
      value: value.clone(),
    })
    .chain(
      null_deletions
        .iter()
        .map(|path| myoxus_infrastructure::app_config::ConfigMutation::Remove { path: path.clone() }),
    )
    .collect::<Vec<_>>();
  match myoxus_infrastructure::app_config::write_config_batch(
    &pool,
    &mutations,
    mode,
    Some(admin_user_id),
    &crate::config::AppConfigStartupValidator,
  )
  .await
  {
    Ok(result) => {
      let imported_count = valid_pairs.len();
      crate::graphql::admin_config::record_committed_config_changes(&state, &result.changes, admin_user_id).await;
      if let Err(error) = state.refresh_config_overrides().await {
        warn!(%error, "config import committed but live refresh failed");
      }
      state.publish_cache_invalidation("app_config", "all").await;
      debug!(
        imported = imported_count,
        deleted = null_deletions.len(),
        mode = params.mode,
        "config import persisted to database"
      );
      (
        StatusCode::OK,
        Json(ImportResult {
          imported: imported_count,
          writeback: Some(result.writeback.as_str()),
          errors: Vec::new(),
        }),
      )
        .into_response()
    }
    Err(e) => {
      let invalid = matches!(
        &e,
        myoxus_infrastructure::app_config::ConfigWriteError::UnknownPath(_)
          | myoxus_infrastructure::app_config::ConfigWriteError::FileOnlyPath(_)
          | myoxus_infrastructure::app_config::ConfigWriteError::InvalidValue { .. }
          | myoxus_infrastructure::app_config::ConfigWriteError::InvalidOrganizationUnit
      );
      let status = if invalid {
        StatusCode::BAD_REQUEST
      } else {
        StatusCode::INTERNAL_SERVER_ERROR
      };
      warn!(error = %e, invalid_candidate = invalid, "config import rejected");
      (
        status,
        Json(ImportResult {
          imported: 0,
          writeback: None,
          errors: vec![ImportError {
            key: "".to_string(),
            message: e.to_string(),
          }],
        }),
      )
        .into_response()
    }
  }
}

/// Single production readiness check result.
#[derive(Debug, Serialize)]
pub struct ReadinessCheck {
  /// Check severity: "CRITICAL", "WARNING", or "INFO"
  category: String,
  /// Config key being checked (e.g., "server.origin")
  key: String,
  /// Human-readable check message
  message: String,
}

/// Response for production readiness checks.
#[derive(Debug, Serialize)]
pub struct ReadinessCheckResponse {
  /// Array of check results
  checks: Vec<ReadinessCheck>,
  /// True if any CRITICAL check failed
  #[serde(rename = "hasCritical")]
  has_critical: bool,
}

/// `GET /api/admin/config/check` — Production readiness checks.
///
/// Performs validation checks on critical configuration keys to ensure
/// the system is production-ready. Returns both passing and failing checks.
/// Admin-only endpoint.
#[instrument(skip_all, level = "debug")]
pub async fn check_production_readiness(State(state): State<ApiState>) -> impl IntoResponse {
  debug!("check_production_readiness endpoint called");

  let mut checks = Vec::new();
  let mut has_critical = false;

  // Get effective config
  let effective = state.effective_config().await;

  // CRITICAL checks
  // 1. server.origin must be configured to a real public URL
  let server_origin = effective.server_origin();
  let is_placeholder_origin = server_origin.is_empty()
    || server_origin.contains("example.com")
    || server_origin.contains("localhost")
    || server_origin.contains("127.0.0.1")
    || server_origin.contains("0.0.0.0");
  if is_placeholder_origin {
    has_critical = true;
    checks.push(ReadinessCheck {
      category: "CRITICAL".to_string(),
      key: "server.origin".to_string(),
      message: format!(
        "externalUrl '{}' is not a production URL (must not be localhost/example.com/empty)",
        server_origin
      ),
    });
  } else {
    checks.push(ReadinessCheck {
      category: "INFO".to_string(),
      key: "server.origin".to_string(),
      message: format!("externalUrl configured: {}", server_origin),
    });
  }

  // 2. Database pool availability (critical)
  if state.metrics_pool().is_some() {
    checks.push(ReadinessCheck {
      category: "INFO".to_string(),
      key: "database.connection".to_string(),
      message: "Database connection pool available".to_string(),
    });
  } else {
    has_critical = true;
    checks.push(ReadinessCheck {
      category: "CRITICAL".to_string(),
      key: "database.connection".to_string(),
      message: "No database pool available".to_string(),
    });
  }

  // 3. Redis connectivity (critical — required for sessions, caching, distributed locks).
  //    We probe with a lightweight GET for a non-existent key. If the round-trip
  //    succeeds, Redis is reachable; if it errors, we flag CRITICAL.
  let redis = state.redis_port();
  match redis.get_string("__readiness_probe__").await {
    Ok(_) => {
      info!("Redis connectivity probe succeeded");
      checks.push(ReadinessCheck {
        category: "INFO".to_string(),
        key: "redis.connection".to_string(),
        message: "Redis reachable (connectivity probe OK)".to_string(),
      });
    }
    Err(e) => {
      warn!(error = %e, "Redis connectivity probe failed");
      has_critical = true;
      checks.push(ReadinessCheck {
        category: "CRITICAL".to_string(),
        key: "redis.connection".to_string(),
        message: format!("Redis not reachable: {}", e),
      });
    }
  }

  // 4. Copilot setup
  let provider = effective.copilot_default_provider();
  if !provider.is_empty() {
    checks.push(ReadinessCheck {
      category: "INFO".to_string(),
      key: "copilot.provider".to_string(),
      message: format!("Copilot configured with provider: {}", provider),
    });
  } else {
    checks.push(ReadinessCheck {
      category: "WARNING".to_string(),
      key: "copilot.provider".to_string(),
      message: "Copilot not configured (provider not set)".to_string(),
    });
  }

  // 6. Logging level check
  let logging_level = effective.logging_level();
  checks.push(ReadinessCheck {
    category: "INFO".to_string(),
    key: "logging.level".to_string(),
    message: format!("Logging level set to: {}", logging_level),
  });

  // 7. Database pool size check
  let db_max_conns = effective.database_max_connections();
  if db_max_conns > 0 {
    checks.push(ReadinessCheck {
      category: "INFO".to_string(),
      key: "database.maxConnections".to_string(),
      message: format!("Database max connections: {}", db_max_conns),
    });
  }

  // 8. S3/R2 storage credentials (critical when remote backend is selected).
  //    Local storage needs no credentials, but S3 and R2 require access_key and
  //    secret_key to authenticate with the object store. Missing credentials will
  //    cause every blob upload/download to fail at runtime.
  let storage = &effective.base.storage;
  match storage.backend {
    StorageBackend::S3 | StorageBackend::R2 => {
      let backend_name = if storage.backend == StorageBackend::S3 {
        "S3"
      } else {
        "R2"
      };
      let ak_missing = storage.access_key.as_deref().unwrap_or("").is_empty();
      let sk_missing = storage.secret_key.as_deref().unwrap_or("").is_empty();
      if ak_missing || sk_missing {
        warn!(
          backend = backend_name,
          access_key_missing = ak_missing,
          secret_key_missing = sk_missing,
          "Storage credentials incomplete for remote backend"
        );
        has_critical = true;
        checks.push(ReadinessCheck {
          category: "CRITICAL".to_string(),
          key: "storage.credentials".to_string(),
          message: format!(
            "{} storage backend configured but credentials missing (access_key: {}, secret_key: {})",
            backend_name,
            if ak_missing { "MISSING" } else { "set" },
            if sk_missing { "MISSING" } else { "set" },
          ),
        });
      } else {
        info!(backend = backend_name, "Storage credentials present");
        checks.push(ReadinessCheck {
          category: "INFO".to_string(),
          key: "storage.credentials".to_string(),
          message: format!("{} storage backend credentials configured", backend_name),
        });
      }
    }
    StorageBackend::Local => {
      checks.push(ReadinessCheck {
        category: "INFO".to_string(),
        key: "storage.credentials".to_string(),
        message: "Local storage backend — no remote credentials required".to_string(),
      });
    }
  }

  // 9. SMTP host validity (warning — email is non-critical but important for
  //    invitations, password resets, and notifications).
  //    An empty smtp_host means email is intentionally disabled. A configured but
  //    blank-looking host hints at a misconfiguration.
  let mail = &effective.base.mail;
  match &mail.smtp_host {
    None => {
      info!("No SMTP host configured — email delivery disabled");
      checks.push(ReadinessCheck {
        category: "WARNING".to_string(),
        key: "mail.smtp".to_string(),
        message: "No SMTP configured — email delivery disabled (invitations, password resets will not work)"
          .to_string(),
      });
    }
    Some(host) if host.trim().is_empty() => {
      warn!("SMTP host is set but empty — likely misconfiguration");
      checks.push(ReadinessCheck {
        category: "WARNING".to_string(),
        key: "mail.smtp".to_string(),
        message: "SMTP host is set but empty — email delivery will fail".to_string(),
      });
    }
    Some(host) => {
      // Basic sanity: host should contain at least one dot or be "localhost"
      let looks_valid = host.contains('.') || host == "localhost";
      if looks_valid {
        info!(smtp_host = %host, "SMTP host configured");
        checks.push(ReadinessCheck {
          category: "INFO".to_string(),
          key: "mail.smtp".to_string(),
          message: format!("SMTP host configured: {}", host),
        });
      } else {
        warn!(smtp_host = %host, "SMTP host looks invalid (no dot, not localhost)");
        checks.push(ReadinessCheck {
          category: "WARNING".to_string(),
          key: "mail.smtp".to_string(),
          message: format!("SMTP host '{}' may not be resolvable (no dot, not localhost)", host),
        });
      }
    }
  }

  (StatusCode::OK, Json(ReadinessCheckResponse { checks, has_critical }))
}
