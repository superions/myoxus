//! `config` subcommand — read and write runtime `app_configs` DB entries + production checks.
//!
//! The `app_configs` table stores key/value pairs that override or extend the
//! static YAML configuration. These are the settings that can also be changed
//! through the Admin UI at runtime (e.g. `copilot.enabled`,
//! OAuth provider credentials, journal settings, …).
//!
//! # Subcommands
//! - `config show [--key <prefix>] [--format table|json]` — list all DB entries
//! - `config set <key> <value>` — upsert a JSON value for a key
//! - `config diff` — list all DB entries that differ from "not set" (alias for show, useful as quick overview)
//! - `config check` — validate production-readiness (CRITICAL/WARNING/INFO checks, exit code 1 if CRITICAL)

use clap::{ArgGroup, Args, Subcommand};
use myoxus_contracts::client_update::CLIENT_UPDATE_CONFIG_KEY;
use myoxus_contracts::config_document::{
  ConfigDocumentFormat, MAX_CONFIG_DOCUMENT_BYTES, decode_config_document, encode_config_yaml,
};
use myoxus_contracts::effective_config::{
  CONFIG_REGISTRY, MASKED_CONFIG_VALUE, RuntimeEffectiveState, find_descriptor, is_sensitive_config_key,
};
use myoxus_contracts::runtime_config::load_server_config_sources;
use myoxus_infrastructure::app_config::{
  ConfigBatchMode, ConfigMutation, SETUP_COMPLETED_CONFIG_KEY, WritebackOutcome, load_validated_app_config_values,
  preview_config_batch, write_config_batch,
};
use serde::Serialize;
use sqlx::PgPool;
use std::{
  collections::{BTreeMap, HashMap},
  io::Read,
};
use tabled::Tabled;

use crate::output::{print_json, print_table};

/// Subcommands for `config`.
#[derive(Subcommand)]
pub enum ConfigCommand {
  /// List all runtime config entries stored in the DB (`app_configs` table).
  Show(ConfigShowArgs),
  /// Set (upsert) a runtime config key/value in the DB.
  Set(ConfigSetArgs),
  /// Show all DB-level config overrides (same as `show` but emphasises diff context).
  Diff(ConfigDiffArgs),
  /// Production-readiness checks (exits with code 1 if CRITICAL issues found).
  Check(ConfigCheckArgs),
  /// Export the current effective config (YAML defaults merged with DB overrides).
  Export(ConfigExportArgs),
  /// Import config keys from a YAML or JSON file into the DB.
  Import(ConfigImportArgs),
}

/// Arguments for `config show`.
#[derive(Args)]
pub struct ConfigShowArgs {
  /// Optional key prefix filter (e.g. `copilot`, `auth`).
  #[arg(long)]
  pub key: Option<String>,

  /// Mask values whose key contains any of these strings (comma-separated).
  /// Defaults to masking keys that contain: secret, password, token, key, credential
  #[arg(long)]
  pub mask: Option<String>,
}

/// Arguments for `config set`.
#[derive(Args)]
pub struct ConfigSetArgs {
  /// Config key (dot-separated, e.g. `copilot.enabled`).
  pub key: String,

  /// Value as a JSON literal (e.g. `true`, `42`, `"hello"`, `{"foo":1}`).
  pub value: String,
}

/// Arguments for `config diff`.
#[derive(Args)]
pub struct ConfigDiffArgs {
  /// Optional key prefix filter (e.g. `copilot`, `auth`).
  #[arg(long)]
  pub key: Option<String>,
}

/// Arguments for `config check`.
#[derive(Args)]
pub struct ConfigCheckArgs {
  /// Optional: show verbose output with detailed explanations.
  #[arg(long)]
  pub verbose: bool,
}

/// Arguments for `config export`.
#[derive(Args)]
#[command(group(
  ArgGroup::new("mode")
    .required(false)
    .multiple(false)
    .args(["effective", "overrides", "raw_source"])
))]
pub struct ConfigExportArgs {
  /// Output file path. Omit for stdout.
  #[arg(long, short)]
  pub output: Option<std::path::PathBuf>,
  /// Export runtime-effective values from YAML, ENV, secret files, and DB.
  #[arg(long)]
  pub effective: bool,
  /// Export only database overrides.
  #[arg(long)]
  pub overrides: bool,
  /// Export source provenance and restart state.
  #[arg(long)]
  pub raw_source: bool,
  /// Output format: yaml (default) or json.
  #[arg(long, default_value = "yaml")]
  pub format: String,
}

/// Arguments for `config import`.
#[derive(Args)]
pub struct ConfigImportArgs {
  /// YAML or JSON file to import. Use `-` to read YAML from stdin.
  pub file: std::path::PathBuf,
  /// Partial (default): only update specified keys. Full: also delete unspecified keys.
  #[arg(long, default_value = "partial")]
  pub mode: String,
  /// Validate only, do not write to DB.
  #[arg(long)]
  pub dry_run: bool,
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// A single `app_configs` row for display.
#[derive(Tabled, Serialize)]
pub struct ConfigRow {
  /// Config key.
  pub key: String,
  /// Config value (JSON), possibly masked.
  pub value: String,
  /// RFC-3339 last-updated timestamp.
  pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `config` subcommand.
pub async fn run(cmd: ConfigCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  match cmd {
    ConfigCommand::Show(args) => show(args, pool, json).await,
    ConfigCommand::Set(args) => set(args, pool, json).await,
    ConfigCommand::Diff(args) => diff(args, pool, json).await,
    ConfigCommand::Check(args) => check(args, pool).await,
    ConfigCommand::Export(args) => export_cmd(args, pool).await,
    ConfigCommand::Import(args) => import_cmd(args, pool, json).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

fn is_sensitive(key: &str, extra_masks: &[&str]) -> bool {
  let lower = key.to_lowercase();
  is_sensitive_config_key(key) || extra_masks.iter().any(|s| lower.contains(s))
}

async fn show(args: ConfigShowArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // Build extra mask list from --mask flag.
  let mask_extra: Vec<&str> = args.mask.as_deref().map(|s| s.split(',').collect()).unwrap_or_default();

  let rows = fetch_config_rows(pool, args.key.as_deref()).await?;

  let display: Vec<ConfigRow> = rows
    .into_iter()
    .map(|(id, value, updated_at)| {
      let value_str = if is_sensitive(&id, &mask_extra) {
        "***masked***".to_string()
      } else {
        value.to_string()
      };
      ConfigRow {
        key: id,
        value: value_str,
        updated_at: updated_at.to_rfc3339(),
      }
    })
    .collect();

  if display.is_empty() {
    println!("(no app_configs entries found)");
    return Ok(());
  }

  if json {
    print_json(&display);
  } else {
    print_table(&display);
  }
  Ok(())
}

async fn set(args: ConfigSetArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  reject_reserved_operational_key(&args.key)?;
  require_database_writable_descriptor(&args.key)?;
  // Parse value as JSON to validate it before writing.
  let json_value = decode_config_document(&args.value, ConfigDocumentFormat::Json)
    .map_err(|e| anyhow::anyhow!("Value is not valid JSON: {e}\nHint: strings need quotes, e.g. '\"hello\"'"))?;

  let result = write_config_batch(
    pool,
    &[ConfigMutation::Set {
      path: args.key.clone(),
      value: json_value.clone(),
    }],
    ConfigBatchMode::Partial,
    None,
    &myoxus_api::config::AppConfigStartupValidator,
  )
  .await
  .map_err(|e| anyhow::anyhow!("Failed to write config: {e}"))?;

  if json {
    print_json(&serde_json::json!({
      "applied": true,
      "path": args.key,
      "writeback": result.writeback.as_str(),
    }));
  } else {
    println!("Set {}; mirror {}.", args.key, result.writeback.as_str());
  }
  Ok(())
}

async fn diff(args: ConfigDiffArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  // `diff` shows all DB-level overrides with a note that they override YAML defaults.
  // (Full YAML-vs-DB diff would require linking myoxus-api config loading; not done here.)
  let rows = fetch_config_rows(pool, args.key.as_deref()).await?;

  let display: Vec<ConfigRow> = rows
    .into_iter()
    .map(|(id, value, updated_at)| {
      let value_str = if is_sensitive(&id, &[]) {
        "***masked***".to_string()
      } else {
        value.to_string()
      };
      ConfigRow {
        key: id,
        value: value_str,
        updated_at: updated_at.to_rfc3339(),
      }
    })
    .collect();

  if display.is_empty() {
    println!("(no DB-level config overrides — all settings use YAML/ENV defaults)");
    return Ok(());
  }

  if !json {
    println!("DB-level config overrides (these take precedence over YAML/ENV defaults):\n");
  }

  if json {
    print_json(&display);
  } else {
    print_table(&display);
  }
  Ok(())
}

// Production-readiness check implementation
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CheckLevel {
  Info,
  Warning,
  Critical,
}

impl CheckLevel {
  fn symbol(&self) -> &'static str {
    match self {
      CheckLevel::Info => "ℹ",
      CheckLevel::Warning => "⚠",
      CheckLevel::Critical => "❌",
    }
  }

  fn color(&self) -> &'static str {
    match self {
      CheckLevel::Info => "\x1b[36m",     // cyan
      CheckLevel::Warning => "\x1b[33m",  // yellow
      CheckLevel::Critical => "\x1b[31m", // red
    }
  }
}

pub(crate) struct CheckResult {
  pub level: CheckLevel,
  pub title: String,
  pub message: String,
}

/// Production-readiness check for the Myoxus server configuration.
async fn check(args: ConfigCheckArgs, pool: &PgPool) -> anyhow::Result<()> {
  let app_configs = fetch_config_rows(pool, None)
    .await?
    .into_iter()
    .map(|(k, v, _)| (k, v))
    .collect::<HashMap<_, _>>();
  let sources = load_server_config_sources()
    .map_err(|error| anyhow::anyhow!("Failed to load effective server configuration: {error}"))?;
  let results = collect_check_results(&args, &sources, &app_configs)?;
  let reset = "\x1b[0m";
  let has_critical = results.iter().any(|r| r.level == CheckLevel::Critical);
  for result in &results {
    println!(
      "{}{}  {}  {}{}",
      result.level.color(),
      result.level.symbol(),
      result.title,
      result.message,
      reset
    );
  }
  if has_critical {
    std::process::exit(1);
  }
  Ok(())
}

/// Share the existing readiness findings without I/O or printing. Doctor may
/// inspect file/ENV state with unavailable DB overrides, but must label that
/// snapshot unverified; an empty map alone never establishes their absence.
pub(crate) fn collect_check_results(
  args: &ConfigCheckArgs,
  sources: &myoxus_contracts::runtime_config::ServerConfigSources,
  app_configs: &HashMap<String, serde_json::Value>,
) -> anyhow::Result<Vec<CheckResult>> {
  let mut results = Vec::new();
  let source_values = sources.source_snapshot.resolved_values();

  // CRITICAL checks — server will not start/run safely
  // 1. Default crypto key
  let crypto = sources
    .source_snapshot
    .resolve(
      find_descriptor("crypto.private_key").expect("registered crypto descriptor"),
      &app_configs,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  let crypto_uses_default = crypto
    .winning_source
    .is_none_or(|source| source == myoxus_contracts::effective_config::EffectiveConfigSource::Default);
  if crypto_uses_default {
    results.push(CheckResult {
      level: CheckLevel::Critical,
      title: "Default Crypto Key".to_string(),
      message: "Server is using the bundled default private key. Configure crypto.private_key through YAML, environment, or MYOXUS__CRYPTO__PRIVATE_KEY_FILE."
        .to_string(),
    });
  } else if args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Crypto Key".to_string(),
      message: "Custom private key is configured.".to_string(),
    });
  }

  // 2. Server origin URL
  let origin = sources
    .source_snapshot
    .resolve(
      find_descriptor("server.origin").expect("registered origin descriptor"),
      &app_configs,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  let runtime_origin = origin.runtime_effective_value.as_ref().and_then(ValueExt::as_string);
  if origin.runtime_effective_state == RuntimeEffectiveState::PendingRestart {
    results.push(CheckResult {
      level: CheckLevel::Warning,
      title: "Server Origin".to_string(),
      message: "A database override is pending canonical writeback and server restart.".to_string(),
    });
  }
  if runtime_origin
    .as_deref()
    .map(|origin| origin.starts_with("http://localhost"))
    .unwrap_or(true)
  {
    results.push(CheckResult {
      level: CheckLevel::Warning,
      title: "Server Origin".to_string(),
      message: "Server origin is localhost or default. For production, set server.origin to your domain.".to_string(),
    });
  } else if args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Server Origin".to_string(),
      message: format!("Server origin is set to: {}", runtime_origin.unwrap_or_default()),
    });
  }

  // 3. SMTP configuration (for email notifications)
  let smtp = sources
    .source_snapshot
    .resolve(
      find_descriptor("mail.smtp_host").expect("registered SMTP descriptor"),
      &app_configs,
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  let has_smtp = smtp
    .runtime_effective_value
    .as_ref()
    .and_then(ValueExt::as_string)
    .is_some_and(|host| !host.trim().is_empty());
  if smtp.runtime_effective_state == RuntimeEffectiveState::PendingRestart {
    results.push(CheckResult {
      level: CheckLevel::Warning,
      title: "SMTP Configuration".to_string(),
      message: "An SMTP override is pending canonical writeback and server restart.".to_string(),
    });
  }
  if !has_smtp {
    results.push(CheckResult {
      level: CheckLevel::Warning,
      title: "SMTP Configuration".to_string(),
      message: "SMTP is not configured. Email notifications will not work.".to_string(),
    });
  } else if args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "SMTP Configuration".to_string(),
      message: "SMTP server is configured.".to_string(),
    });
  }

  // WARNING checks — functionality limitations or potential issues
  // 4. Rate limiting
  let throttle_enabled = effective_bool(source_values, &app_configs, "throttle.enabled").unwrap_or(false);
  if !throttle_enabled {
    results.push(CheckResult {
      level: CheckLevel::Warning,
      title: "Rate Limiting".to_string(),
      message: "Rate limiting is disabled. Enable it in production to prevent abuse.".to_string(),
    });
  } else if args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Rate Limiting".to_string(),
      message: "Rate limiting is enabled.".to_string(),
    });
  }

  // 5. Metrics
  let metrics_enabled = effective_bool(source_values, &app_configs, "metrics.enabled").unwrap_or(true);
  if !metrics_enabled && args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Metrics".to_string(),
      message: "Metrics collection is disabled (not required, but helpful for monitoring).".to_string(),
    });
  } else if metrics_enabled {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Metrics".to_string(),
      message: "Metrics collection is enabled.".to_string(),
    });
  }

  // 6. OAuth configuration
  let has_oauth = effective_is_set(source_values, &app_configs, "oauth.google_client_id")
    || effective_is_set(source_values, &app_configs, "oauth.github_client_id")
    || effective_prefix_is_set(source_values, &app_configs, "oauth.providers");
  if !has_oauth && args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "OAuth Providers".to_string(),
      message: "No OAuth providers configured (optional for local-only deployments).".to_string(),
    });
  } else if has_oauth {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "OAuth Providers".to_string(),
      message: "OAuth is configured.".to_string(),
    });
  }

  // INFO checks — nice-to-have or informational
  // 7. Copilot
  let copilot_enabled = effective_is_set(source_values, &app_configs, "copilot.default_provider")
    && effective_prefix_is_set(source_values, &app_configs, "copilot.providers");
  if !copilot_enabled && args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Copilot (AI Features)".to_string(),
      message: "Copilot is not configured (optional feature).".to_string(),
    });
  } else if copilot_enabled {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Copilot (AI Features)".to_string(),
      message: "Copilot/AI features are configured.".to_string(),
    });
  }

  // 8. Full-text search indexer
  let indexer_enabled = effective_bool(source_values, &app_configs, "indexer.enabled").unwrap_or(false);
  if !indexer_enabled && args.verbose {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Full-Text Search".to_string(),
      message: "Full-text search indexer is disabled (optional feature).".to_string(),
    });
  } else if indexer_enabled {
    results.push(CheckResult {
      level: CheckLevel::Info,
      title: "Full-Text Search".to_string(),
      message: "Full-text search indexer is enabled.".to_string(),
    });
  }

  Ok(results)
}

// ---------------------------------------------------------------------------
// export_cmd (B-03)
// ---------------------------------------------------------------------------

async fn export_cmd(args: ConfigExportArgs, pool: &PgPool) -> anyhow::Result<()> {
  let database_overrides = load_validated_app_config_values(pool)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  let sources = load_server_config_sources()
    .map_err(|error| anyhow::anyhow!("Failed to load effective server configuration: {error}"))?;
  let output_value = if args.raw_source {
    let fields = CONFIG_REGISTRY
      .iter()
      .map(|descriptor| sources.source_snapshot.resolve(descriptor, &database_overrides))
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    serde_json::to_value(fields)?
  } else {
    let mut config_map = serde_json::Map::new();
    if args.overrides {
      for (id, value) in &database_overrides {
        config_map.insert(id.clone(), mask_export_value(id, value.clone()));
      }
    } else {
      for descriptor in CONFIG_REGISTRY {
        let resolved = sources
          .source_snapshot
          .resolve(descriptor, &database_overrides)
          .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if let Some(value) = resolved.runtime_effective_value {
          config_map.insert(descriptor.path.to_string(), value);
        }
      }
    }
    ValueExt::object(config_map)
  };

  let output = if args.format == "json" {
    serde_json::to_string_pretty(&output_value).map_err(|e| anyhow::anyhow!("JSON serialization error: {e}"))?
  } else {
    encode_config_yaml(&output_value).map_err(|e| anyhow::anyhow!("YAML serialization error: {e}"))?
  };

  let exported_count = output_value
    .as_object()
    .map_or_else(|| output_value.as_array().map_or(1, Vec::len), serde_json::Map::len);

  if let Some(path) = &args.output {
    std::fs::write(path, &output).map_err(|e| anyhow::anyhow!("Failed to write to {}: {e}", path.display()))?;
    println!("Exported {} entries to {}", exported_count, path.display());
  } else {
    print!("{output}");
  }

  Ok(())
}

// ---------------------------------------------------------------------------
// import_cmd (B-04)
// ---------------------------------------------------------------------------

/// Recursively flatten a nested JSON object into dot-notation keys.
fn flatten_json(
  prefix: &str,
  value: &serde_json::Value,
  out: &mut BTreeMap<String, serde_json::Value>,
) -> Result<(), String> {
  if !prefix.is_empty() && find_descriptor(prefix).is_some_and(|descriptor| descriptor.structured()) {
    return insert_flat_config_path(prefix, value.clone(), out);
  }
  match value {
    serde_json::Value::Object(map) => {
      for (k, v) in map {
        let new_key = if prefix.is_empty() {
          k.clone()
        } else {
          format!("{}.{}", prefix, k)
        };
        flatten_json(&new_key, v, out)?;
      }
    }
    _ => {
      insert_flat_config_path(prefix, value.clone(), out)?;
    }
  }
  Ok(())
}

fn insert_flat_config_path(
  path: &str,
  value: serde_json::Value,
  out: &mut BTreeMap<String, serde_json::Value>,
) -> Result<(), String> {
  let conflicts = out.keys().any(|existing| {
    existing == path || existing.starts_with(&format!("{path}.")) || path.starts_with(&format!("{existing}."))
  });
  if conflicts {
    return Err(format!("conflicting dotted and nested configuration path `{path}`"));
  }
  out.insert(path.to_string(), value);
  Ok(())
}

#[derive(Serialize)]
struct ConfigImportOutput {
  applied: bool,
  dry_run: bool,
  mode: String,
  requested_sets: usize,
  removals: usize,
  changed: usize,
  writeback: Option<&'static str>,
  errors: Vec<ConfigImportOutputError>,
}

#[derive(Serialize)]
struct ConfigImportOutputError {
  path: String,
  message: String,
}

fn writeback_label(outcome: WritebackOutcome) -> &'static str {
  outcome.as_str()
}

async fn import_cmd(args: ConfigImportArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let content = read_config_import_source(&args.file)?;

  // Parse as JSON or YAML depending on extension (or try YAML first as it is a superset).
  let raw: serde_json::Value = {
    let ext = args
      .file
      .extension()
      .and_then(|e| e.to_str())
      .unwrap_or("")
      .to_lowercase();
    if ext == "json" {
      decode_config_document(&content, ConfigDocumentFormat::Json)
        .map_err(|e| anyhow::anyhow!("Failed to parse JSON: {e}"))?
    } else {
      // YAML (or .yml, or unknown extension — YAML is tried first).
      decode_config_document(&content, ConfigDocumentFormat::Yaml)
        .map_err(|e| anyhow::anyhow!("Failed to parse YAML: {e}"))?
    }
  };

  // Flatten nested structures into dot-notation keys.
  let mut flat = BTreeMap::new();
  flatten_json("", &raw, &mut flat).map_err(|error| anyhow::anyhow!(error))?;

  // Validate: collect errors and valid pairs.
  let mut errors: Vec<(String, String)> = Vec::new();
  let mut valid_deletions: Vec<String> = Vec::new();
  let mut valid_pairs: Vec<(String, serde_json::Value)> = Vec::new();

  for (key, value) in &flat {
    if key.is_empty() {
      errors.push((key.clone(), "key cannot be empty".to_string()));
      continue;
    }
    if key == CLIENT_UPDATE_CONFIG_KEY || key == SETUP_COMPLETED_CONFIG_KEY {
      errors.push((
        key.clone(),
        "reserved operational state; use `myoxus-cli client-update`".to_string(),
      ));
      continue;
    }
    if let Err(error) = require_database_writable_descriptor(key)
      && !(key == "git_sync.https_ca_bundle_path" && value.is_null())
    {
      errors.push((key.clone(), error.to_string()));
      continue;
    }
    // Null values → signal deletion.
    if value.is_null() {
      valid_deletions.push(key.clone());
      continue;
    }
    // Only String, Number, Bool, Object (and Array) are allowed.
    if value.is_object() || value.is_array() {
      // Objects/arrays are allowed: they represent structured config values.
    }
    valid_pairs.push((key.clone(), value.clone()));
  }

  if !errors.is_empty() {
    if json {
      print_json(&ConfigImportOutput {
        applied: false,
        dry_run: args.dry_run,
        mode: args.mode.clone(),
        requested_sets: valid_pairs.len(),
        removals: valid_deletions.len(),
        changed: 0,
        writeback: None,
        errors: errors
          .iter()
          .map(|(path, message)| ConfigImportOutputError {
            path: path.clone(),
            message: message.clone(),
          })
          .collect(),
      });
    }
    anyhow::bail!(
      "config import contains {} invalid key(s); no changes were applied",
      errors.len()
    );
  }

  let mode = match args.mode.as_str() {
    "partial" => ConfigBatchMode::Partial,
    "full" => ConfigBatchMode::ReplaceRegistered,
    other => anyhow::bail!("unsupported import mode `{other}`; expected partial or full"),
  };
  let mutations = valid_pairs
    .iter()
    .map(|(path, value)| ConfigMutation::Set {
      path: path.clone(),
      value: value.clone(),
    })
    .chain(
      valid_deletions
        .iter()
        .map(|path| ConfigMutation::Remove { path: path.clone() }),
    )
    .collect::<Vec<_>>();
  if args.dry_run {
    let preview =
      match preview_config_batch(pool, &mutations, mode, &myoxus_api::config::AppConfigStartupValidator).await {
        Ok(preview) => preview,
        Err(error) => {
          if json {
            print_json(&ConfigImportOutput {
              applied: false,
              dry_run: true,
              mode: args.mode.clone(),
              requested_sets: valid_pairs.len(),
              removals: valid_deletions.len(),
              changed: 0,
              writeback: None,
              errors: vec![ConfigImportOutputError {
                path: "candidate".to_string(),
                message: error.to_string(),
              }],
            });
          }
          return Err(anyhow::anyhow!("Config candidate is invalid: {error}"));
        }
      };
    let output = ConfigImportOutput {
      applied: false,
      dry_run: true,
      mode: args.mode,
      requested_sets: preview.requested_sets,
      removals: preview.removals,
      changed: preview.changes.len(),
      writeback: None,
      errors: Vec::new(),
    };
    if json {
      print_json(&output);
    } else {
      println!(
        "Dry-run: {} set request(s), {} removal(s), {} durable change(s). No changes applied.",
        output.requested_sets, output.removals, output.changed
      );
    }
    return Ok(());
  }
  let result = match write_config_batch(
    pool,
    &mutations,
    mode,
    None,
    &myoxus_api::config::AppConfigStartupValidator,
  )
  .await
  {
    Ok(result) => result,
    Err(error) => {
      if json {
        print_json(&ConfigImportOutput {
          applied: false,
          dry_run: false,
          mode: args.mode.clone(),
          requested_sets: valid_pairs.len(),
          removals: valid_deletions.len(),
          changed: 0,
          writeback: None,
          errors: vec![ConfigImportOutputError {
            path: "candidate".to_string(),
            message: error.to_string(),
          }],
        });
      }
      return Err(anyhow::anyhow!("Failed to import config: {error}"));
    }
  };

  let output = ConfigImportOutput {
    applied: true,
    dry_run: false,
    mode: args.mode,
    requested_sets: valid_pairs.len(),
    removals: result
      .changes
      .iter()
      .filter(|change| change.new_value.is_none())
      .count(),
    changed: result.changes.len(),
    writeback: Some(writeback_label(result.writeback)),
    errors: Vec::new(),
  };
  if json {
    print_json(&output);
  } else {
    println!(
      "Imported {} key(s); {} removal(s); mirror {}.",
      output.requested_sets,
      output.removals,
      output.writeback.unwrap_or("unknown")
    );
  }

  Ok(())
}

fn read_config_import_source(path: &std::path::Path) -> anyhow::Result<String> {
  let mut content = String::new();
  let limit = u64::try_from(MAX_CONFIG_DOCUMENT_BYTES + 1).expect("config document bound fits u64");
  if path.as_os_str() == "-" {
    std::io::stdin()
      .lock()
      .take(limit)
      .read_to_string(&mut content)
      .map_err(|error| anyhow::anyhow!("Failed to read configuration from stdin: {error}"))?;
  } else {
    std::fs::File::open(path)
      .map_err(|error| anyhow::anyhow!("Failed to open {}: {error}", path.display()))?
      .take(limit)
      .read_to_string(&mut content)
      .map_err(|error| anyhow::anyhow!("Failed to read {}: {error}", path.display()))?;
  }
  if content.len() > MAX_CONFIG_DOCUMENT_BYTES {
    anyhow::bail!("configuration document exceeds the {MAX_CONFIG_DOCUMENT_BYTES}-byte limit");
  }
  Ok(content)
}

// Helper functions to extract config values with type safety
fn reject_reserved_operational_key(key: &str) -> anyhow::Result<()> {
  if key == CLIENT_UPDATE_CONFIG_KEY {
    anyhow::bail!("{key} is reserved operational state; use `myoxus-cli client-update`");
  }
  if key == SETUP_COMPLETED_CONFIG_KEY {
    anyhow::bail!("{key} is reserved operational state managed by the setup lifecycle");
  }
  Ok(())
}

fn require_database_writable_descriptor(key: &str) -> anyhow::Result<()> {
  let descriptor = find_descriptor(key).ok_or_else(|| anyhow::anyhow!("unknown configuration path `{key}`"))?;
  if !descriptor.database_writable() {
    anyhow::bail!("{key} is configured through YAML, environment, or a secret file only");
  }
  Ok(())
}

fn mask_export_value(key: &str, value: serde_json::Value) -> serde_json::Value {
  if is_sensitive_config_key(key) && !value.is_null() {
    serde_json::Value::String(MASKED_CONFIG_VALUE.to_string())
  } else {
    value
  }
}

fn effective_bool(
  sources: &std::collections::BTreeMap<String, serde_json::Value>,
  overrides: &HashMap<String, serde_json::Value>,
  path: &str,
) -> Option<bool> {
  overrides
    .get(path)
    .or_else(|| sources.get(path))
    .and_then(serde_json::Value::as_bool)
}

fn effective_is_set(
  sources: &std::collections::BTreeMap<String, serde_json::Value>,
  overrides: &HashMap<String, serde_json::Value>,
  path: &str,
) -> bool {
  overrides
    .get(path)
    .or_else(|| sources.get(path))
    .is_some_and(|value| !value.is_null())
}

fn effective_prefix_is_set(
  sources: &std::collections::BTreeMap<String, serde_json::Value>,
  overrides: &HashMap<String, serde_json::Value>,
  prefix: &str,
) -> bool {
  overrides
    .iter()
    .chain(sources.iter())
    .any(|(path, value)| path.starts_with(prefix) && !value.is_null())
}

struct ValueExt;

impl ValueExt {
  fn as_string(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(ToString::to_string)
  }

  fn object(values: serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    serde_json::Value::Object(values)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fetch rows from `app_configs`, optionally filtered by key prefix.
async fn fetch_config_rows(
  pool: &PgPool,
  prefix: Option<&str>,
) -> anyhow::Result<Vec<(String, serde_json::Value, chrono::DateTime<chrono::Utc>)>> {
  let rows: Vec<(String, serde_json::Value, chrono::DateTime<chrono::Utc>)> = if let Some(p) = prefix {
    let pattern = format!("{p}%");
    sqlx::query_as("SELECT id, value, updated_at FROM app_configs WHERE id LIKE $1 ORDER BY id")
      .bind(pattern)
      .fetch_all(pool)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to query app_configs: {e}"))?
  } else {
    sqlx::query_as("SELECT id, value, updated_at FROM app_configs ORDER BY id")
      .fetch_all(pool)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to query app_configs: {e}"))?
  };
  rows
    .into_iter()
    .filter(|(path, _, _)| path != CLIENT_UPDATE_CONFIG_KEY && path != SETUP_COMPLETED_CONFIG_KEY)
    .map(|(path, value, updated_at)| {
      let descriptor = find_descriptor(&path).ok_or_else(|| anyhow::anyhow!("unknown app_configs path `{path}`"))?;
      if !descriptor.database_writable() && path != "git_sync.https_ca_bundle_path" {
        anyhow::bail!("file-only path `{path}` must not be stored in app_configs");
      }
      Ok((path, value, updated_at))
    })
    .collect()
}

// ---------------------------------------------------------------------------
// Tests (P91-CFG-B-T04)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cli_config_export_masking_cannot_be_disabled() {
    let mut map: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    map.insert("copilot.enabled".to_string(), serde_json::Value::Bool(true));
    map.insert(
      "crypto.private_key".to_string(),
      serde_json::Value::String("super-secret-value".to_string()),
    );
    map.insert(
      "server.name".to_string(),
      serde_json::Value::String("MyoxusTest".to_string()),
    );

    let config_map: serde_json::Map<String, serde_json::Value> = map
      .into_iter()
      .map(|(key, value)| (key.clone(), mask_export_value(&key, value)))
      .collect();

    let yaml_str = encode_config_yaml(&config_map).expect("YAML serialization must not fail");
    assert!(!yaml_str.is_empty(), "YAML output must not be empty");

    // Round-trip: the produced YAML must parse back without error.
    let reparsed: serde_json::Value =
      decode_config_document(&yaml_str, ConfigDocumentFormat::Yaml).expect("Produced YAML must be parseable");
    assert!(reparsed.is_object(), "Re-parsed YAML must be a JSON object");

    // Invariant: sensitive key is masked, non-sensitive key retains its value.
    let obj = reparsed.as_object().unwrap();
    assert_eq!(
      obj.get("crypto.private_key").and_then(|v| v.as_str()),
      Some(MASKED_CONFIG_VALUE),
      "Sensitive key must always be redacted"
    );
    assert_eq!(
      obj.get("server.name").and_then(|v| v.as_str()),
      Some("MyoxusTest"),
      "Non-sensitive key must retain its original value"
    );
  }

  #[test]
  fn cli_rejects_yaml_only_database_writes_and_accepts_runtime_keys() {
    assert!(require_database_writable_descriptor("crypto.private_key").is_err());
    assert!(require_database_writable_descriptor("git_sync.webhook_secret").is_err());
    assert!(require_database_writable_descriptor("git_sync.enabled").is_ok());
    assert!(require_database_writable_descriptor("server.origin").is_ok());
  }

  #[test]
  fn cli_config_import_rejects_conflicting_dotted_and_nested_paths() {
    let raw = decode_config_document(
      "server:\n  name: nested\nserver.name: dotted\n",
      ConfigDocumentFormat::Yaml,
    )
    .unwrap();
    let mut flat = BTreeMap::new();
    let error = flatten_json("", &raw, &mut flat).unwrap_err();
    assert!(error.contains("server.name"));
  }

  /// cli_config_roundtrip:
  /// Export (flatten to map) → YAML serialize → YAML deserialize → flatten
  /// again must produce an identical key set and identical values.
  #[test]
  fn cli_config_roundtrip() {
    // Simulate the output of export_cmd: a flat map of dot-notation keys.
    let mut original: HashMap<String, serde_json::Value> = HashMap::new();
    original.insert("logging.level".to_string(), serde_json::json!("info"));
    original.insert("server.name".to_string(), serde_json::json!("Roundtrip"));
    original.insert("copilot.enabled".to_string(), serde_json::Value::Bool(false));

    // Step 1: serialize to YAML (as export_cmd does for flat maps).
    let yaml_str = encode_config_yaml(&original).expect("YAML serialization must succeed");
    assert!(!yaml_str.is_empty(), "Serialized YAML must not be empty");

    // Step 2: parse the YAML back (as import_cmd does).
    let reparsed: serde_json::Value =
      decode_config_document(&yaml_str, ConfigDocumentFormat::Yaml).expect("Produced YAML must be re-parseable");

    // Step 3: flatten the re-parsed structure.
    // The shared codec preserves flat keys verbatim (no nesting introduced),
    // so the re-parsed object should have the same dot-notation keys directly.
    let mut roundtripped = BTreeMap::new();
    flatten_json("", &reparsed, &mut roundtripped).unwrap();

    // Invariant: all original keys survive the roundtrip.
    for (key, expected) in &original {
      let actual = roundtripped
        .get(key)
        .unwrap_or_else(|| panic!("Key '{key}' must survive the export→import roundtrip"));
      assert_eq!(
        actual, expected,
        "Value for key '{key}' must be unchanged after roundtrip"
      );
    }

    // Invariant: no extra keys were introduced.
    assert_eq!(
      roundtripped.len(),
      original.len(),
      "Roundtrip must not introduce or drop keys"
    );
  }

  #[test]
  fn generic_config_writes_reject_client_update_control() {
    let error = reject_reserved_operational_key(CLIENT_UPDATE_CONFIG_KEY)
      .expect_err("reserved state must not bypass its transition service");

    assert!(error.to_string().contains("myoxus-cli client-update"));
    assert!(reject_reserved_operational_key("client.downloadUrl").is_ok());
  }
}
