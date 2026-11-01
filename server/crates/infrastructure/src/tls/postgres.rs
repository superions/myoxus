// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL options retain connection policy while adding bootstrap roots.

use sqlx::postgres::PgConnectOptions;
use std::{io::Write, path::PathBuf, str::FromStr};

use super::ValidatedCaBundle;

/// Configure trust before pool creation. SSL mode, client certificates and all
/// other URL/environment options remain owned by SQLx. Inline PEM freezes both
/// the explicit connection root and the global roots for pool reconnections.
pub fn connect_options(url: &str, bundle: Option<&ValidatedCaBundle>) -> Result<PgConnectOptions, String> {
  let options =
    PgConnectOptions::from_str(url).map_err(|_| "invalid PostgreSQL connection configuration".to_string())?;
  let Some(bundle) = bundle else {
    return Ok(options);
  };
  let pem = combined_roots(url, bundle)?;
  Ok(options.ssl_root_cert_from_pem(pem))
}

/// SQLx accepts these deployed spellings; the last explicit query value wins
/// over PGSSLROOTCERT, just as in its option parser. Never log the URL.
fn explicit_root_path(url: &str) -> Result<Option<PathBuf>, String> {
  let parsed = reqwest::Url::parse(url).map_err(|_| "invalid PostgreSQL connection configuration".to_string())?;
  Ok(
    parsed
      .query_pairs()
      .filter(|(key, _)| matches!(key.as_ref(), "sslrootcert" | "ssl-root-cert" | "ssl-ca"))
      .last()
      .map(|(_, value)| PathBuf::from(value.as_ref()))
      .or_else(|| std::env::var_os("PGSSLROOTCERT").map(PathBuf::from)),
  )
}

pub(super) fn combined_roots(url: &str, bundle: &ValidatedCaBundle) -> Result<Vec<u8>, String> {
  let mut combined = match explicit_root_path(url)? {
    Some(path) => {
      std::fs::read(path).map_err(|_| "explicit PostgreSQL root certificate could not be read".to_string())?
    }
    None => Vec::new(),
  };
  combined.push(b'\n');
  combined.extend_from_slice(bundle.pem());
  Ok(combined)
}

/// Own the combined libpq trust file for the complete pg_dump/psql lifetime.
/// The caller retains this file until the child exits; configured URIs and the
/// parent environment are never rewritten.
pub struct ChildTrust {
  file: tempfile::NamedTempFile,
  /// libpq's `sslrootcert=system` implies verify-full even without sslmode.
  pub ssl_mode: Option<&'static str>,
}

impl ChildTrust {
  pub fn path(&self) -> &std::path::Path {
    self.file.path()
  }
}

fn system_root_mode(url: &reqwest::Url, environment_mode: Option<&str>) -> Result<&'static str, String> {
  let explicit = url
    .query_pairs()
    .filter(|(key, _)| key == "sslmode")
    .last()
    .map(|(_, value)| value.into_owned());
  if explicit
    .as_deref()
    .or(environment_mode)
    .is_some_and(|mode| mode != "verify-full")
  {
    return Err("libpq system trust requires sslmode=verify-full".into());
  }
  Ok("verify-full")
}

pub fn child_root_file(url: &str, bundle: Option<&ValidatedCaBundle>) -> Result<Option<ChildTrust>, String> {
  let Some(bundle) = bundle else {
    return Ok(None);
  };
  let parsed = reqwest::Url::parse(url).map_err(|_| "invalid PostgreSQL connection configuration".to_string())?;
  let mut combined = Vec::new();
  // libpq's default root file is additional operator trust, not a reason to
  // discard the host's public CAs when installing an explicit combined file.
  let existing = explicit_root_path(url)?.or_else(|| {
    std::env::var_os("HOME")
      .map(|home| PathBuf::from(home).join(".postgresql/root.crt"))
      .filter(|path| path.exists())
  });
  let ssl_mode = if existing.as_deref() == Some(std::path::Path::new("system")) {
    Some(system_root_mode(&parsed, std::env::var("PGSSLMODE").ok().as_deref())?)
  } else {
    None
  };
  if let Some(path) = existing
    && path != std::path::Path::new("system")
  {
    combined.extend(std::fs::read(path).map_err(|_| "existing libpq root certificate could not be read".to_string())?);
    combined.push(b'\n');
  }
  let native = rustls_native_certs_redis::load_native_certs();
  if !native.errors.is_empty() {
    return Err("native trust store could not be loaded".to_string());
  }
  for der in native.certs {
    combined.extend_from_slice(pem::encode(&pem::Pem::new("CERTIFICATE", der.as_ref())).as_bytes());
  }
  combined.extend_from_slice(bundle.pem());
  let mut file = tempfile::NamedTempFile::new().map_err(|_| "backup CA file could not be created".to_string())?;
  file
    .write_all(&combined)
    .and_then(|_| file.flush())
    .map_err(|_| "backup CA file could not be materialized".to_string())?;
  Ok(Some(ChildTrust { file, ssl_mode }))
}

/// A private libpq service projection, retained together with its CA snapshot
/// until pg_dump/psql exits. PGDATABASE is a database name, not a URI parser.
/// The service file keeps credentials out of argv and allows additive trust
/// without modifying the configured connection URL or losing its parameters.
pub struct ChildConnection {
  service: tempfile::NamedTempFile,
  _roots: Option<ChildTrust>,
}

impl ChildConnection {
  pub fn configure(&self, command: &mut std::process::Command) {
    command
      .arg("--no-password")
      .env("PGSERVICE", "myoxus_backup")
      .env("PGSERVICEFILE", self.service.path());
  }
}

pub fn child_connection(url: &str, bundle: Option<&ValidatedCaBundle>) -> Result<ChildConnection, String> {
  let roots = child_root_file(url, bundle)?;
  let parameters = child_parameters(url, roots.as_ref())?;
  let mut service = tempfile::NamedTempFile::new().map_err(|_| "backup connection file could not be created")?;
  service
    .write_all(b"[myoxus_backup]\n")
    .map_err(|_| "backup connection file could not be written")?;
  for (key, value) in parameters {
    // libpq service files have no quoted/multiline value syntax. Reject input
    // that would change meaning or inject another option, without echoing it.
    if value.contains(['\n', '\r', '\0']) || value.trim() != value {
      return Err("PostgreSQL connection value cannot be represented safely in a libpq service file".into());
    }
    writeln!(service, "{key}={value}").map_err(|_| "backup connection file could not be written")?;
  }
  service
    .flush()
    .map_err(|_| "backup connection file could not be flushed")?;
  Ok(ChildConnection { service, _roots: roots })
}

fn child_parameters(
  url: &str,
  roots: Option<&ChildTrust>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
  let parsed = reqwest::Url::parse(url).map_err(|_| "invalid PostgreSQL connection configuration")?;
  if !matches!(parsed.scheme(), "postgres" | "postgresql") {
    return Err("invalid PostgreSQL connection scheme".into());
  }
  let mut values = std::collections::BTreeMap::new();
  for (key, value) in [
    (
      "host",
      parsed
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']'),
    ),
    ("user", parsed.username()),
    ("password", parsed.password().unwrap_or_default()),
    ("dbname", parsed.path().strip_prefix('/').unwrap_or(parsed.path())),
  ] {
    if !value.is_empty() {
      let value = urlencoding::decode(value).map_err(|_| "invalid PostgreSQL connection encoding")?;
      values.insert(key.to_string(), value.into_owned());
    }
  }
  if let Some(port) = parsed.port() {
    values.insert("port".into(), port.to_string());
  }
  for (key, value) in parsed.query_pairs() {
    let key = match key.as_ref() {
      "ssl-root-cert" | "ssl-ca" => "sslrootcert",
      other => other,
    };
    if key.is_empty()
      || !key
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
      return Err("invalid PostgreSQL connection parameter".into());
    }
    values.insert(key.to_string(), value.into_owned());
  }
  if let Some(roots) = roots {
    values.insert(
      "sslrootcert".into(),
      roots.path().to_str().ok_or("invalid backup CA file path")?.to_string(),
    );
    if let Some(mode) = roots.ssl_mode {
      values.insert("sslmode".into(), mode.to_string());
    }
  }
  Ok(values)
}

#[cfg(test)]
mod tests {
  use super::*;
  use sqlx::postgres::PgSslMode;

  #[test]
  fn child_service_preserves_connection_parameters_and_cleans_up() {
    let url = "postgresql://operator:p%40ss%3Dword@[::1]:5433/database%20name?sslmode=verify-full&application_name=backup&connect_timeout=4";
    let connection = child_connection(url, None).expect("private service");
    let path = connection.service.path().to_path_buf();
    let text = std::fs::read_to_string(&path).expect("service content");
    for line in [
      "host=::1",
      "port=5433",
      "user=operator",
      "password=p@ss=word",
      "dbname=database name",
      "sslmode=verify-full",
      "application_name=backup",
      "connect_timeout=4",
    ] {
      assert!(
        text.lines().any(|actual| actual == line),
        "missing expected service parameter"
      );
    }
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(
        std::fs::metadata(&path).expect("metadata").permissions().mode() & 0o777,
        0o600
      );
    }
    drop(connection);
    assert!(!path.exists());
  }

  #[test]
  fn child_service_rejects_parameter_injection_without_echoing_secrets() {
    for url in [
      "postgres://user:secret%0Asslmode%3Ddisable@localhost/db",
      "postgres://localhost/db?host%0Apassword=secret",
    ] {
      let error = child_connection(url, None).err().expect("invalid service value");
      assert!(!error.contains("secret"));
      assert!(!error.contains("postgres://"));
    }
  }

  #[test]
  fn materializing_system_roots_preserves_libpq_full_verification() {
    let url = reqwest::Url::parse("postgres://localhost/db").expect("URL");
    assert_eq!(system_root_mode(&url, None).expect("implicit policy"), "verify-full");
    assert!(system_root_mode(&url, Some("prefer")).is_err());
    let full = reqwest::Url::parse("postgres://localhost/db?sslmode=verify-full").expect("URL");
    assert_eq!(
      system_root_mode(&full, Some("prefer")).expect("URL wins"),
      "verify-full"
    );
    let weak = reqwest::Url::parse("postgres://localhost/db?sslmode=require").expect("URL");
    assert!(system_root_mode(&weak, Some("verify-full")).is_err());
  }

  #[test]
  fn explicit_connection_root_and_global_root_are_both_retained() {
    let root = tempfile::tempdir().expect("temporary config");
    let mut params = rcgen::CertificateParams::default();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca = rcgen::Certificate::from_params(params)
      .expect("CA")
      .serialize_pem()
      .expect("PEM");
    std::fs::write(root.path().join("global.pem"), &ca).expect("write global CA");
    let explicit_path = root.path().join("connection.pem");
    std::fs::write(&explicit_path, &ca).expect("write connection CA");
    let bundle = super::super::load_bundle(root.path(), "global.pem")
      .expect("load CA")
      .expect("configured CA");
    let mut url = reqwest::Url::parse("postgres://user:secret@localhost/db?sslmode=verify-full").expect("URL");
    url
      .query_pairs_mut()
      .append_pair("sslrootcert", explicit_path.to_str().expect("path"));
    let options = connect_options(url.as_str(), Some(&bundle)).expect("options");
    assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));
    let combined = combined_roots(url.as_str(), &bundle).expect("combined roots");
    assert_eq!(pem::parse_many(combined).expect("PEM").len(), 2);
    let connection = child_connection(url.as_str(), Some(&bundle)).expect("child trust");
    let roots = connection._roots.as_ref().expect("global trust");
    let values = child_parameters(url.as_str(), Some(roots)).expect("projected parameters");
    assert_eq!(values["sslrootcert"], roots.path().to_str().expect("path"));
    assert_eq!(values["sslmode"], "verify-full");
    let child_pem = std::fs::read(roots.path()).expect("combined child roots");
    assert!(pem::parse_many(child_pem).expect("child PEM").len() >= 2);
    assert!(
      url
        .query_pairs()
        .any(|(key, value)| key == "sslrootcert" && value == explicit_path.to_str().expect("path"))
    );
    std::fs::remove_file(explicit_path).expect("remove explicit root");
    let error = connect_options(url.as_str(), Some(&bundle)).expect_err("missing explicit root must not be ignored");
    assert!(!error.contains("secret"));
    assert!(!error.contains("postgres://"));
  }
}
