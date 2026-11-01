// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared discovery, layering and secret-file handling for server configuration.

use std::{
  fmt,
  fs::File as FsFile,
  io::Read,
  path::{Path, PathBuf},
};

use config::{Config, ConfigBuilder, ConfigError, Environment, File, FileFormat};

use crate::{
  config_document::{ConfigDocumentFormat, decode_config_document},
  effective_config::{CONFIG_REGISTRY, ConfigSourceSnapshot, EffectiveConfigSource},
  oauth_config::normalize_oauth_provider_source_layer_named,
};

/// Environment variable selecting the optional runtime-overlay mirror.
pub const CONFIG_WRITEBACK_PATH_ENV: &str = "MYOXUS__CONFIG__WRITEBACK_PATH";
/// Allowlisted secret-file environment variable for the database URL.
pub const DATABASE_URL_FILE_ENV: &str = "MYOXUS__DATABASE__URL_FILE";
/// Allowlisted secret-file environment variable for the server private key.
pub const CRYPTO_PRIVATE_KEY_FILE_ENV: &str = "MYOXUS__CRYPTO__PRIVATE_KEY_FILE";
/// Allowlisted protected file source for the external speech API key.
pub const TRANSCRIPTION_API_KEY_FILE_ENV: &str = "MYOXUS__TRANSCRIPTION__API_KEY_FILE";

/// Historical database URL file variable accepted only at the source boundary.
pub const LEGACY_DATABASE_URL_FILE_ENV: &str = "DATABASE_URL_FILE";

const MAX_SECRET_FILE_BYTES: u64 = 64 * 1024;
const DEVELOPMENT_DATABASE_URL: &str = "postgres://myoxus:myoxus@localhost:5432/myoxus";

/// Bootstrap-only additional trust. `Some("")` explicitly selects public roots
/// and must not fall back to a database-owned legacy Git setting.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct TlsConfig {
  pub additional_ca_bundle_path: Option<String>,
}

/// Resolve only file/ENV inputs, before any database connection is attempted.
/// Conflicting deployed and global keys require an explicit operator decision.
pub fn resolve_additional_ca_path(global: Option<&str>, legacy: Option<&str>) -> Result<Option<String>, ConfigError> {
  match (global.map(str::trim), legacy.map(str::trim)) {
    (Some(global), Some(legacy)) if global != legacy => Err(ConfigError::Message(
      "conflicting tls.additional_ca_bundle_path and deprecated git_sync.https_ca_bundle_path".to_string(),
    )),
    (Some(path), _) | (None, Some(path)) => Ok(Some(path.to_string())),
    (None, None) => Ok(None),
  }
}

/// Canonical paths shared by config loading and API writeback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerConfigPaths {
  /// Directory containing the canonical packaged YAML layers.
  pub base_path: PathBuf,
  /// Explicit runtime overlay loaded after package-local YAML.
  pub runtime_overlay_path: Option<PathBuf>,
  /// Explicit operator-owned YAML target for best-effort writeback.
  pub writeback_path: Option<PathBuf>,
}

/// Loaded source stack plus its resolved source metadata.
pub struct ServerConfigSources {
  /// Fully layered, unredacted in-process configuration builder result.
  pub config: Config,
  /// Sanitized effective values and source provenance. Sensitive values are
  /// reduced to set/unset state before this snapshot is constructed.
  pub source_snapshot: ConfigSourceSnapshot,
  /// Whether an operator supplied the canonical model, before legacy alias normalization.
  pub explicit_transcription_model: bool,
  /// Paths used to construct the source stack.
  pub paths: ServerConfigPaths,
  /// Convenience alias for `paths.base_path` retained for deserializers.
  pub base_path: PathBuf,
  /// Validated active run-mode name.
  pub run_mode: String,
  /// Whether `RUN_MODE` was absent and development mode was selected.
  pub defaulted_run_mode: bool,
}

/// Stable, non-sensitive category for secret-file failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretFileErrorKind {
  /// The configured path does not exist.
  Missing,
  /// The configured path is not a regular file.
  NotRegularFile,
  /// The file exceeds the bounded secret size.
  TooLarge,
  /// Metadata or bytes could not be read.
  Unreadable,
  /// Secret bytes are not valid UTF-8.
  InvalidUtf8,
  /// The file contains no secret after one terminal newline is removed.
  Empty,
  /// The secret contains a NUL byte.
  ContainsNul,
}

/// Non-sensitive secret-file failure. The source identifies an allowlisted
/// option or environment variable; the credential-bearing path is omitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecretFileError {
  source: &'static str,
  kind: SecretFileErrorKind,
}

impl SecretFileError {
  /// Returns the allowlisted option or environment-variable name.
  pub fn source_name(&self) -> &'static str {
    self.source
  }

  /// Returns the non-sensitive failure category.
  pub fn kind(&self) -> SecretFileErrorKind {
    self.kind
  }
}

impl fmt::Display for SecretFileError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    let reason = match self.kind {
      SecretFileErrorKind::Missing => "does not exist",
      SecretFileErrorKind::NotRegularFile => "is not a regular file",
      SecretFileErrorKind::TooLarge => "exceeds the 64 KiB limit",
      SecretFileErrorKind::Unreadable => "could not be read",
      SecretFileErrorKind::InvalidUtf8 => "does not contain valid UTF-8",
      SecretFileErrorKind::Empty => "is empty",
      SecretFileErrorKind::ContainsNul => "contains a NUL byte",
    };
    write!(formatter, "{} secret file {reason}", self.source)
  }
}

impl std::error::Error for SecretFileError {}

/// Read one explicitly allowlisted secret file without exposing its path or
/// contents in the returned error. Exactly one terminal LF or CRLF is removed;
/// all other whitespace remains part of the secret.
pub fn read_secret_file(path: &Path, source: &'static str) -> Result<String, SecretFileError> {
  String::from_utf8(read_secret_bytes(path, source)?).map_err(|_| SecretFileError {
    source,
    kind: SecretFileErrorKind::InvalidUtf8,
  })
}

/// Read bounded secret bytes with the same newline, NUL and redaction contract
/// as [`read_secret_file`]. Container PostgreSQL passwords are byte-oriented;
/// percent-encoding must not silently replace non-UTF-8 bytes.
pub fn read_secret_bytes(path: &Path, source: &'static str) -> Result<Vec<u8>, SecretFileError> {
  let metadata = path.metadata().map_err(|error| SecretFileError {
    source,
    kind: if error.kind() == std::io::ErrorKind::NotFound {
      SecretFileErrorKind::Missing
    } else {
      SecretFileErrorKind::Unreadable
    },
  })?;
  if !metadata.is_file() {
    return Err(SecretFileError {
      source,
      kind: SecretFileErrorKind::NotRegularFile,
    });
  }
  if metadata.len() > MAX_SECRET_FILE_BYTES {
    return Err(SecretFileError {
      source,
      kind: SecretFileErrorKind::TooLarge,
    });
  }

  let mut bytes = Vec::with_capacity(metadata.len() as usize);
  FsFile::open(path)
    .and_then(|mut file| file.by_ref().take(MAX_SECRET_FILE_BYTES + 1).read_to_end(&mut bytes))
    .map_err(|_| SecretFileError {
      source,
      kind: SecretFileErrorKind::Unreadable,
    })?;
  if bytes.len() as u64 > MAX_SECRET_FILE_BYTES {
    return Err(SecretFileError {
      source,
      kind: SecretFileErrorKind::TooLarge,
    });
  }
  if bytes.ends_with(b"\r\n") {
    bytes.truncate(bytes.len() - 2);
  } else if bytes.ends_with(b"\n") {
    bytes.truncate(bytes.len() - 1);
  }
  if bytes.is_empty() {
    return Err(SecretFileError {
      source,
      kind: SecretFileErrorKind::Empty,
    });
  }
  if bytes.contains(&0) {
    return Err(SecretFileError {
      source,
      kind: SecretFileErrorKind::ContainsNul,
    });
  }
  Ok(bytes)
}

/// Resolve config paths once. Writeback is enabled only by an explicit path;
/// package-owned config directories are never probed or mutated.
pub fn resolve_server_config_paths() -> ServerConfigPaths {
  let base_path = discover_config_base_path();
  let writeback_path = non_empty_env_path(CONFIG_WRITEBACK_PATH_ENV);
  ServerConfigPaths {
    base_path,
    runtime_overlay_path: writeback_path.clone(),
    writeback_path,
  }
}

/// Load the canonical default/run-mode/package-local/runtime/environment/secret stack.
///
/// Consumers deserialize only their owned projection, while source discovery,
/// precedence and the closed secret allowlist remain identical for API, worker
/// and operator CLI processes.
pub fn load_server_config_sources() -> Result<ServerConfigSources, ConfigError> {
  load_server_config_sources_inner(RuntimeOverlayInput::ConfiguredPath)
}

/// Load the real baseline and environment stack with a caller-prepared runtime
/// overlay. This is used only for side-effect-free startup candidate validation;
/// it does not read or require a writable mirror mount.
pub fn load_server_config_sources_for_candidate(
  runtime_overlay_yaml: Option<&str>,
) -> Result<ServerConfigSources, ConfigError> {
  load_server_config_sources_inner(RuntimeOverlayInput::Prepared(runtime_overlay_yaml))
}

enum RuntimeOverlayInput<'a> {
  ConfiguredPath,
  Prepared(Option<&'a str>),
}

fn load_server_config_sources_inner(overlay: RuntimeOverlayInput<'_>) -> Result<ServerConfigSources, ConfigError> {
  let (run_mode, defaulted_run_mode) = match std::env::var("RUN_MODE") {
    Ok(value) => (validate_run_mode(value)?, false),
    Err(std::env::VarError::NotPresent) => ("development".to_string(), true),
    Err(std::env::VarError::NotUnicode(_)) => {
      return Err(ConfigError::Message("RUN_MODE is not valid UTF-8".to_string()));
    }
  };
  let paths = resolve_server_config_paths();
  let (mut config, layers) = build_source_stack(&paths, &run_mode, overlay)?;
  let resolved = config.clone().try_deserialize::<serde_json::Value>()?;
  let mut source_snapshot = ConfigSourceSnapshot::from_resolved_values(&resolved);
  for layer in layers {
    source_snapshot.record_layer(layer.source, &layer.source_key, &layer.values);
  }
  for descriptor in CONFIG_REGISTRY {
    let environment_path = descriptor.environment_path();
    if std::env::var_os(&environment_path).is_some() {
      source_snapshot.record_explicit(descriptor.path, EffectiveConfigSource::Environment, &environment_path);
    }
    if let Some(secret_source) = descriptor.secret_source
      && std::env::var_os(secret_source).is_some()
    {
      source_snapshot.record_explicit(descriptor.path, EffectiveConfigSource::SecretFile, secret_source);
    }
  }
  if std::env::var_os("MYOXUS__COPILOT__TRANSCRIPTION_MODEL").is_some() {
    source_snapshot.record_explicit(
      "copilot.transcription_model",
      EffectiveConfigSource::Environment,
      "MYOXUS__COPILOT__TRANSCRIPTION_MODEL",
    );
  }
  let explicit_transcription_model = config.get::<serde_json::Value>("transcription.model").is_ok();
  config = normalize_transcription_model(config, &mut source_snapshot)?;
  config = normalize_tls_bootstrap(config, &mut source_snapshot)?;
  let base_path = paths.base_path.clone();

  Ok(ServerConfigSources {
    config,
    source_snapshot,
    explicit_transcription_model,
    paths,
    base_path,
    run_mode,
    defaulted_run_mode,
  })
}

fn normalize_transcription_model(
  mut config: Config,
  snapshot: &mut ConfigSourceSnapshot,
) -> Result<Config, ConfigError> {
  if config.get::<serde_json::Value>("transcription.model").is_err()
    && let Ok(value) = config.get::<String>("copilot.transcription_model")
  {
    snapshot.record_alias(
      "copilot.transcription_model",
      "transcription.model",
      serde_json::Value::String(value.clone()),
    );
    config = Config::builder()
      .add_source(config)
      .set_override("transcription.model", value)?
      .build()?;
  }
  Ok(config)
}

fn normalize_tls_bootstrap(
  mut config: Config,
  source_snapshot: &mut ConfigSourceSnapshot,
) -> Result<Config, ConfigError> {
  let resolved = config.clone().try_deserialize::<serde_json::Value>()?;
  let global = resolved.pointer("/tls/additional_ca_bundle_path");
  let legacy = resolved.pointer("/git_sync/https_ca_bundle_path");
  for value in [global, legacy].into_iter().flatten() {
    if !value.is_null() && !value.is_string() {
      return Err(ConfigError::Message(
        "additional CA bundle paths must be strings".to_string(),
      ));
    }
  }
  let normalized = resolve_additional_ca_path(
    global.and_then(serde_json::Value::as_str),
    legacy.and_then(serde_json::Value::as_str),
  )?;
  if let Some(path) = normalized {
    config = Config::builder()
      .add_source(config)
      .set_override("tls.additional_ca_bundle_path", path.clone())?
      .build()?;
    if global.and_then(serde_json::Value::as_str).is_none() {
      source_snapshot.record_alias(
        "git_sync.https_ca_bundle_path",
        "tls.additional_ca_bundle_path",
        serde_json::Value::String(path),
      );
    }
  }
  Ok(config)
}

/// Resolve the CLI database URL through file-only CLI inputs and the shared
/// server config stack. The returned value must remain in process memory and
/// must never be attached to diagnostics or subprocess arguments.
pub fn load_cli_database_url(explicit_file: Option<&Path>) -> Result<String, ConfigError> {
  if let Some(path) = explicit_file {
    return read_secret_file(path, "--database-url-file").map_err(|error| ConfigError::Message(error.to_string()));
  }
  if let Some(path) = env_path(DATABASE_URL_FILE_ENV)? {
    return read_secret_file(&path, DATABASE_URL_FILE_ENV).map_err(|error| ConfigError::Message(error.to_string()));
  }
  if let Some(path) = env_path(LEGACY_DATABASE_URL_FILE_ENV)? {
    return read_secret_file(&path, LEGACY_DATABASE_URL_FILE_ENV)
      .map_err(|error| ConfigError::Message(error.to_string()));
  }

  let sources = load_server_config_sources()?;
  let database_url = sources
    .config
    .get_string("database.url")
    .map_err(|_| ConfigError::Message("database.url is not configured for the operator CLI".to_string()))?;
  validate_cli_database_url(&sources.run_mode, &database_url)?;
  Ok(database_url)
}

fn validate_cli_database_url(run_mode: &str, database_url: &str) -> Result<(), ConfigError> {
  if run_mode == "production" && database_url == DEVELOPMENT_DATABASE_URL {
    Err(ConfigError::Message(
      "database.url must be explicitly configured in production".to_string(),
    ))
  } else {
    Ok(())
  }
}

#[derive(Debug)]
struct SanitizedConfigLayer {
  source: EffectiveConfigSource,
  source_key: String,
  values: serde_json::Value,
}

fn build_source_stack(
  paths: &ServerConfigPaths,
  run_mode: &str,
  runtime_overlay: RuntimeOverlayInput<'_>,
) -> Result<(Config, Vec<SanitizedConfigLayer>), ConfigError> {
  let mut builder = Config::builder();
  let mut layers = Vec::new();
  for (path, source) in [
    (paths.base_path.join("default.yaml"), EffectiveConfigSource::Default),
    (
      paths.base_path.join(format!("{run_mode}.yaml")),
      EffectiveConfigSource::RunModeYaml,
    ),
    (paths.base_path.join("local.yaml"), EffectiveConfigSource::LocalYaml),
  ] {
    if let Some(layer) = normalized_yaml_layer(&path, source)? {
      let json = serde_json::to_string(&layer.values).map_err(|error| ConfigError::Message(error.to_string()))?;
      builder = builder.add_source(File::from_str(&json, FileFormat::Json));
      layers.push(layer);
    }
  }
  let runtime_layer = match runtime_overlay {
    RuntimeOverlayInput::ConfiguredPath => paths
      .runtime_overlay_path
      .as_deref()
      .map(|path| normalized_yaml_layer(path, EffectiveConfigSource::RuntimeOverlay))
      .transpose()?
      .flatten(),
    RuntimeOverlayInput::Prepared(Some(contents)) => Some(normalized_yaml_contents(
      contents,
      EffectiveConfigSource::RuntimeOverlay,
      CONFIG_WRITEBACK_PATH_ENV.to_string(),
    )?),
    RuntimeOverlayInput::Prepared(None) => None,
  };
  if let Some(layer) = runtime_layer {
    let json = serde_json::to_string(&layer.values).map_err(|error| ConfigError::Message(error.to_string()))?;
    builder = builder.add_source(File::from_str(&json, FileFormat::Json));
    layers.push(layer);
  }
  // Environment keys are conventionally snake_case. Normalize the structured
  // provider aliases before merging so a higher-precedence environment field
  // replaces its YAML equivalent instead of becoming a second Serde alias.
  let environment = Config::builder()
    .add_source(Environment::with_prefix("MYOXUS").separator("__"))
    .build()?;
  let mut environment_values = environment.try_deserialize::<serde_json::Value>()?;
  normalize_oauth_provider_layers(&mut environment_values)?;
  let environment_json =
    serde_json::to_string(&environment_values).map_err(|error| ConfigError::Message(error.to_string()))?;
  builder = builder.add_source(File::from_str(&environment_json, FileFormat::Json));
  builder = apply_allowlisted_secret(builder, DATABASE_URL_FILE_ENV, "database.url")?;
  builder = apply_allowlisted_secret(builder, CRYPTO_PRIVATE_KEY_FILE_ENV, "crypto.private_key")?;
  builder = apply_allowlisted_secret(builder, TRANSCRIPTION_API_KEY_FILE_ENV, "transcription.api_key")?;
  Ok((builder.build()?, layers))
}

fn normalized_yaml_layer(
  path: &Path,
  source: EffectiveConfigSource,
) -> Result<Option<SanitizedConfigLayer>, ConfigError> {
  if !path.exists() {
    return Ok(None);
  }
  let contents = std::fs::read_to_string(path)
    .map_err(|error| ConfigError::Message(format!("could not read config source {}: {error}", path.display())))?;
  Ok(Some(normalized_yaml_contents(
    &contents,
    source,
    match source {
      EffectiveConfigSource::Default => "default.yaml".to_string(),
      EffectiveConfigSource::RunModeYaml => path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("run-mode.yaml")
        .to_string(),
      EffectiveConfigSource::LocalYaml => "local.yaml".to_string(),
      EffectiveConfigSource::RuntimeOverlay => CONFIG_WRITEBACK_PATH_ENV.to_string(),
      _ => "config".to_string(),
    },
  )?))
}

fn normalized_yaml_contents(
  contents: &str,
  source: EffectiveConfigSource,
  source_key: String,
) -> Result<SanitizedConfigLayer, ConfigError> {
  let mut values = decode_config_document(contents, ConfigDocumentFormat::Yaml)
    .map_err(|error| ConfigError::Message(error.to_string()))?;
  normalize_oauth_provider_layers(&mut values)?;
  Ok(SanitizedConfigLayer {
    source,
    source_key,
    values,
  })
}

fn normalize_oauth_provider_layers(values: &mut serde_json::Value) -> Result<(), ConfigError> {
  let Some(providers) = values
    .get_mut("oauth")
    .and_then(|oauth| oauth.get_mut("providers"))
    .and_then(serde_json::Value::as_object_mut)
  else {
    return Ok(());
  };
  for (provider_name, provider) in providers.iter_mut() {
    let normalized = normalize_oauth_provider_source_layer_named(provider_name, provider.take())
      .map_err(|error| ConfigError::Message(format!("oauth.providers.{provider_name}: {}", error.message())))?;
    *provider = normalized;
  }
  Ok(())
}

fn apply_allowlisted_secret(
  builder: ConfigBuilder<config::builder::DefaultState>,
  source: &'static str,
  key: &'static str,
) -> Result<ConfigBuilder<config::builder::DefaultState>, ConfigError> {
  let Some(path) = env_path(source)? else {
    return Ok(builder);
  };
  let value = read_secret_file(&path, source).map_err(|error| ConfigError::Message(error.to_string()))?;
  builder.set_override(key, value)
}

fn discover_config_base_path() -> PathBuf {
  let mut directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
  for _ in 0..5 {
    if directory.join("config").is_dir() {
      return directory.join("config");
    }
    let Some(parent) = directory.parent() else {
      break;
    };
    directory = parent.to_path_buf();
  }
  PathBuf::from("config")
}

fn validate_run_mode(value: String) -> Result<String, ConfigError> {
  if !value.is_empty()
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
  {
    Ok(value)
  } else {
    Err(ConfigError::Message(
      "RUN_MODE must contain only ASCII letters, digits, '-' or '_'".to_string(),
    ))
  }
}

fn env_path(source: &'static str) -> Result<Option<PathBuf>, ConfigError> {
  match std::env::var(source) {
    Ok(value) if value.is_empty() => Err(ConfigError::Message(format!("{source} must not be empty"))),
    Ok(value) => Ok(Some(PathBuf::from(value))),
    Err(std::env::VarError::NotPresent) => Ok(None),
    Err(std::env::VarError::NotUnicode(_)) => Err(ConfigError::Message(format!("{source} is not valid UTF-8"))),
  }
}

fn non_empty_env_path(source: &'static str) -> Option<PathBuf> {
  std::env::var_os(source)
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
  #[test]
  fn transcription_legacy_model_is_ingress_only_and_new_key_wins() {
    let source = config::Config::builder()
      .set_override("copilot.transcription_model", "legacy-model")
      .unwrap()
      .build()
      .unwrap();
    let mut snapshot = crate::effective_config::ConfigSourceSnapshot::default();
    let source = super::normalize_transcription_model(source, &mut snapshot).unwrap();
    assert_eq!(source.get::<String>("transcription.model").unwrap(), "legacy-model");
    assert!(source.get::<bool>("transcription.enabled").is_err());
    assert!(source.get::<String>("transcription.endpoint").is_err());
    let source = config::Config::builder()
      .add_source(source)
      .set_override("transcription.model", "new-model")
      .unwrap()
      .build()
      .unwrap();
    assert_eq!(
      super::normalize_transcription_model(source, &mut snapshot)
        .unwrap()
        .get::<String>("transcription.model")
        .unwrap(),
      "new-model"
    );
  }

  use std::{fs, sync::Mutex};

  use serde::Deserialize;
  use tempfile::tempdir;

  use super::*;

  static ENV_LOCK: Mutex<()> = Mutex::new(());

  #[test]
  fn bootstrap_tls_uses_real_file_and_environment_layers_without_database_access() {
    let _guard = ENV_LOCK.lock().expect("environment lock");
    let dir = tempdir().unwrap();
    let default = dir.path().join("default.yaml");
    fs::write(
      &default,
      "tls: { additional_ca_bundle_path: null }\ngit_sync: { https_ca_bundle_path: null }\n",
    )
    .unwrap();
    let overlay = dir.path().join("runtime.yaml");
    fs::write(&overlay, "git_sync: { https_ca_bundle_path: ca/company.pem }\n").unwrap();
    let mut permissions = fs::metadata(&overlay).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&overlay, permissions).unwrap();
    let paths = ServerConfigPaths {
      base_path: dir.path().to_path_buf(),
      runtime_overlay_path: Some(overlay.clone()),
      writeback_path: Some(overlay.clone()),
    };
    let load = || {
      let (config, layers) = build_source_stack(&paths, "development", RuntimeOverlayInput::ConfiguredPath)?;
      let resolved = config.clone().try_deserialize::<serde_json::Value>()?;
      let mut snapshot = ConfigSourceSnapshot::from_resolved_values(&resolved);
      for layer in layers {
        snapshot.record_layer(layer.source, &layer.source_key, &layer.values);
      }
      normalize_tls_bootstrap(config, &mut snapshot)
    };
    assert_eq!(
      load().unwrap().get_string("tls.additional_ca_bundle_path").unwrap(),
      "ca/company.pem"
    );
    // SAFETY: these tests serialize environment mutation with ENV_LOCK and no
    // transport threads are started by this configuration-only fixture.
    unsafe {
      std::env::set_var("MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH", "different.pem");
    }
    let conflict = load();
    unsafe {
      std::env::remove_var("MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH");
    }
    assert!(conflict.is_err());
    unsafe {
      std::env::set_var("MYOXUS__GIT_SYNC__HTTPS_CA_BUNDLE_PATH", "ca/env.pem");
    }
    let legacy_environment = load();
    unsafe {
      std::env::remove_var("MYOXUS__GIT_SYNC__HTTPS_CA_BUNDLE_PATH");
    }
    assert_eq!(
      legacy_environment
        .unwrap()
        .get_string("tls.additional_ca_bundle_path")
        .unwrap(),
      "ca/env.pem"
    );
    assert_eq!(
      fs::read_to_string(&overlay).unwrap(),
      "git_sync: { https_ca_bundle_path: ca/company.pem }\n"
    );
  }

  #[test]
  fn bootstrap_ca_inputs_preserve_absence_empty_and_deployed_alias() {
    assert_eq!(resolve_additional_ca_path(None, None).unwrap(), None);
    assert_eq!(resolve_additional_ca_path(Some(""), None).unwrap(), Some(String::new()));
    assert_eq!(
      resolve_additional_ca_path(None, Some(" ca/root.pem ")).unwrap(),
      Some("ca/root.pem".into())
    );
    assert_eq!(
      resolve_additional_ca_path(Some("ca/root.pem"), Some("ca/root.pem")).unwrap(),
      Some("ca/root.pem".into())
    );
    assert!(resolve_additional_ca_path(Some(""), Some("ca/root.pem")).is_err());
    assert!(resolve_additional_ca_path(Some("ca/new.pem"), Some("ca/old.pem")).is_err());
  }

  #[derive(Debug, Deserialize)]
  struct TestConfig {
    office_test: TestValue,
    database: TestValue,
    crypto: CryptoValue,
  }

  #[derive(Debug, Deserialize)]
  struct TestValue {
    value: Option<String>,
    url: Option<String>,
  }

  #[derive(Debug, Deserialize)]
  struct CryptoValue {
    private_key: String,
  }

  #[test]
  fn secret_reader_preserves_content_and_removes_exactly_one_line_ending() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("credential");

    fs::write(&path, b" secret \n\n").expect("write secret");
    assert_eq!(read_secret_file(&path, DATABASE_URL_FILE_ENV).unwrap(), " secret \n");
    fs::write(&path, b"secret\r\n").expect("write CRLF secret");
    assert_eq!(read_secret_file(&path, DATABASE_URL_FILE_ENV).unwrap(), "secret");
    fs::write(&path, b"\xff\r\n").expect("write byte-oriented password");
    assert_eq!(read_secret_bytes(&path, "POSTGRES_PASSWORD_FILE").unwrap(), [0xff]);
  }

  #[test]
  fn secret_reader_rejects_unsafe_inputs_without_disclosing_path_or_content() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("credential-with-sensitive-name");
    for (bytes, expected_kind) in [
      (Vec::new(), SecretFileErrorKind::Empty),
      (b"secret\0value".to_vec(), SecretFileErrorKind::ContainsNul),
      (
        vec![b'x'; MAX_SECRET_FILE_BYTES as usize + 1],
        SecretFileErrorKind::TooLarge,
      ),
      (vec![0xff], SecretFileErrorKind::InvalidUtf8),
    ] {
      fs::write(&path, bytes).expect("write invalid secret");
      let error = read_secret_file(&path, CRYPTO_PRIVATE_KEY_FILE_ENV).unwrap_err();
      assert_eq!(error.kind(), expected_kind);
      let rendered = error.to_string();
      assert!(!rendered.contains("credential-with-sensitive-name"));
      assert!(!rendered.contains("secret\0value"));
    }
    let directory_error = read_secret_file(dir.path(), DATABASE_URL_FILE_ENV).unwrap_err();
    assert_eq!(directory_error.kind(), SecretFileErrorKind::NotRegularFile);
  }

  #[test]
  fn source_stack_obeys_overlay_environment_and_secret_precedence() {
    let _guard = ENV_LOCK.lock().expect("environment lock");
    let dir = tempdir().expect("tempdir");
    fs::write(
      dir.path().join("default.yaml"),
      "office_test: { value: default }\ndatabase: { url: default }\ncrypto: { private_key: default }\n",
    )
    .expect("default config");
    fs::write(dir.path().join("production.yaml"), "office_test: { value: run-mode }\n").expect("run-mode config");
    fs::write(
      dir.path().join("local.yaml"),
      "office_test: { value: packaged-local }\n",
    )
    .expect("packaged local config");
    let overlay = dir.path().join("runtime.yaml");
    fs::write(
      &overlay,
      "office_test: { value: runtime }\ndatabase: { url: runtime }\n",
    )
    .expect("runtime config");
    let db_secret = dir.path().join("db-secret");
    let crypto_secret = dir.path().join("crypto-secret");
    fs::write(&db_secret, "secret-db\n").expect("database secret");
    fs::write(&crypto_secret, "secret-crypto\n").expect("crypto secret");

    unsafe {
      std::env::set_var("MYOXUS__OFFICE_TEST__VALUE", "environment");
      std::env::set_var(DATABASE_URL_FILE_ENV, &db_secret);
      std::env::set_var(CRYPTO_PRIVATE_KEY_FILE_ENV, &crypto_secret);
    }
    let paths = ServerConfigPaths {
      base_path: dir.path().to_path_buf(),
      runtime_overlay_path: Some(overlay.clone()),
      writeback_path: Some(overlay),
    };
    let loaded: TestConfig = build_source_stack(&paths, "production", RuntimeOverlayInput::ConfiguredPath)
      .expect("build source stack")
      .0
      .try_deserialize()
      .expect("deserialize source stack");
    unsafe {
      std::env::remove_var("MYOXUS__OFFICE_TEST__VALUE");
      std::env::remove_var(DATABASE_URL_FILE_ENV);
      std::env::remove_var(CRYPTO_PRIVATE_KEY_FILE_ENV);
    }

    assert_eq!(loaded.office_test.value.as_deref(), Some("environment"));
    assert_eq!(loaded.database.url.as_deref(), Some("secret-db"));
    assert_eq!(loaded.crypto.private_key, "secret-crypto");
  }

  #[test]
  fn run_mode_cannot_escape_the_config_directory() {
    assert!(validate_run_mode("production".to_string()).is_ok());
    assert!(validate_run_mode("review-1".to_string()).is_ok());
    assert!(validate_run_mode("../../credential".to_string()).is_err());
    assert!(validate_run_mode(String::new()).is_err());
  }

  #[test]
  fn boot_stack_reads_canonical_config_families_without_translation() {
    let dir = tempdir().expect("tempdir");
    fs::write(
      dir.path().join("default.yaml"),
      "git_sync:\n  enabled: true\n  network_timeout_secs: 45\nmail:\n  smtp_host: smtp.example\n  smtp_port: 587\n",
    )
    .expect("canonical config");
    let paths = ServerConfigPaths {
      base_path: dir.path().to_path_buf(),
      runtime_overlay_path: None,
      writeback_path: None,
    };

    let resolved: serde_json::Value = build_source_stack(&paths, "development", RuntimeOverlayInput::ConfiguredPath)
      .expect("canonical stack")
      .0
      .try_deserialize()
      .expect("resolved values");
    assert_eq!(resolved["git_sync"]["enabled"], true);
    assert_eq!(resolved["git_sync"]["network_timeout_secs"], 45);
    assert_eq!(resolved["mail"]["smtp_host"], "smtp.example");
    assert_eq!(resolved["mail"]["smtp_port"], 587);
  }

  #[test]
  fn provider_aliases_are_normalized_per_layer_before_case_preserving_merge() {
    let _guard = ENV_LOCK.lock().expect("environment lock");
    let dir = tempdir().expect("tempdir");
    fs::write(
      dir.path().join("default.yaml"),
      r#"oauth:
  providers:
    oidc:
      clientId: BaseClient
      clientSecret: secret
      authUrl: https://idp.example/authorize
      tokenUrl: https://idp.example/token
      userinfoUrl: https://idp.example/userinfo
      claims:
        emailVerified: EmailVerified
        groupsSource: userinfo
      groupDirectory:
        type: keycloak
        baseUrl: https://idp.example/base
        realm: TenantCase
        clientId: DirectoryClient
        clientSecret: base-secret
        claimValueMode: name
    AcmeIdentity:
      clientId: CustomClient
      clientSecret: custom-secret
      authUrl: https://idp.example/authorize
      tokenUrl: https://idp.example/token
      userinfoUrl: https://idp.example/userinfo
"#,
    )
    .expect("default provider config");
    fs::write(
      dir.path().join("local.yaml"),
      "oauth:\n  providers:\n    oidc:\n      claims:\n        groups_source: id_token\n      group_directory:\n        base_url: https://idp.example/deployment-prefix\n        claim_value_mode: path\n",
    )
    .expect("provider alias overlay");
    // SAFETY: ENV_LOCK serializes these configuration-only tests; this fixture
    // starts no transport threads, and restores the inputs before assertions.
    unsafe {
      std::env::set_var("MYOXUS__OAUTH__PROVIDERS__OIDC__CLIENT_ID", "EnvironmentClient");
      std::env::set_var(
        "MYOXUS__OAUTH__PROVIDERS__OIDC__GROUP_DIRECTORY__CLIENT_SECRET",
        "environment-secret",
      );
    }
    let paths = ServerConfigPaths {
      base_path: dir.path().to_path_buf(),
      runtime_overlay_path: None,
      writeback_path: None,
    };

    let resolved = build_source_stack(&paths, "development", RuntimeOverlayInput::ConfiguredPath)
      .and_then(|(config, _)| config.try_deserialize::<serde_json::Value>());
    unsafe {
      std::env::remove_var("MYOXUS__OAUTH__PROVIDERS__OIDC__CLIENT_ID");
      std::env::remove_var("MYOXUS__OAUTH__PROVIDERS__OIDC__GROUP_DIRECTORY__CLIENT_SECRET");
    }
    let resolved = resolved.expect("resolved provider source stack");

    let provider = &resolved["oauth"]["providers"]["oidc"];
    assert_eq!(provider["clientId"], "EnvironmentClient");
    assert_eq!(provider["claims"]["emailVerified"], "EmailVerified");
    assert_eq!(provider["claims"]["groupsSource"], "id_token");
    assert!(provider.get("client_id").is_none());
    assert!(provider["claims"].get("groups_source").is_none());
    let decoded =
      crate::oauth_config::decode_oauth_provider_named("oidc", provider.clone()).expect("complete merged provider");
    let decoded = serde_json::to_value(decoded).unwrap();
    assert_eq!(
      decoded["groupDirectory"],
      serde_json::json!({"type":"keycloak", "baseUrl":"https://idp.example/deployment-prefix", "realm":"TenantCase", "clientId":"DirectoryClient", "clientSecret":"environment-secret", "claimValueMode":"path"})
    );
    assert_eq!(
      resolved["oauth"]["providers"]["AcmeIdentity"]["clientId"],
      "CustomClient"
    );
    assert!(resolved["oauth"]["providers"].get("acmeidentity").is_none());
  }

  #[test]
  fn provider_duplicate_aliases_fail_within_one_source_layer() {
    let dir = tempdir().expect("tempdir");
    fs::write(
      dir.path().join("default.yaml"),
      "oauth:\n  providers:\n    oidc:\n      clientId: one\n      client_id: two\n",
    )
    .expect("duplicate provider config");
    let paths = ServerConfigPaths {
      base_path: dir.path().to_path_buf(),
      runtime_overlay_path: None,
      writeback_path: None,
    };

    let error = build_source_stack(&paths, "development", RuntimeOverlayInput::ConfiguredPath)
      .unwrap_err()
      .to_string();
    assert!(error.contains("duplicate field `provider.clientId`"));
    assert!(!error.contains("one"));
    assert!(!error.contains("two"));
  }

  #[test]
  fn explicit_cli_database_file_has_highest_priority() {
    let _guard = ENV_LOCK.lock().expect("environment lock");
    let dir = tempdir().expect("tempdir");
    let explicit = dir.path().join("explicit");
    let environment = dir.path().join("environment");
    fs::write(&explicit, "postgres://explicit\n").expect("explicit secret");
    fs::write(&environment, "postgres://environment\n").expect("environment secret");
    unsafe { std::env::set_var(DATABASE_URL_FILE_ENV, &environment) };
    let resolved = load_cli_database_url(Some(&explicit)).expect("resolve database URL");
    unsafe { std::env::remove_var(DATABASE_URL_FILE_ENV) };
    assert_eq!(resolved, "postgres://explicit");
  }

  #[test]
  fn production_rejects_the_packaged_development_database_default() {
    let error = validate_cli_database_url("production", DEVELOPMENT_DATABASE_URL).unwrap_err();
    assert_eq!(
      error.to_string(),
      "database.url must be explicitly configured in production"
    );
    assert!(validate_cli_database_url("development", DEVELOPMENT_DATABASE_URL).is_ok());
    assert!(validate_cli_database_url("production", "postgres://configured").is_ok());
  }
}
