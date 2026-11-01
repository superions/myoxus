// SPDX-License-Identifier: AGPL-3.0-or-later
//! Confined, validated additional CA trust shared by outgoing TLS adapters.

pub mod bundle_management;
pub mod http_error;
pub mod postgres;
pub mod redis;

/// Install the server's Ring provider before constructing any TLS consumer.
/// Reqwest's `rustls-no-provider` feature does not infer Rustls Cargo features;
/// repeated calls preserve the process provider already selected at startup.
pub fn initialize_crypto_provider() {
  if rustls::crypto::CryptoProvider::get_default().is_none() {
    drop(rustls::crypto::ring::default_provider().install_default());
  }
}

pub fn snapshot_id(bundle: Option<&ValidatedCaBundle>) -> &str {
  bundle.map_or("library-public-roots", |bundle| bundle.snapshot_id.as_str())
}

use sha2::{Digest, Sha256};
use std::{
  io::Write,
  path::{Component, Path, PathBuf},
  sync::Arc,
};

#[derive(Clone)]
pub struct ValidatedCaBundle {
  pub canonical_path: PathBuf,
  pub certificate_count: usize,
  pub snapshot_id: String,
  pem: Arc<[u8]>,
  certificates: Arc<[Vec<u8>]>,
  materialized: Arc<tempfile::NamedTempFile>,
}

impl std::fmt::Debug for ValidatedCaBundle {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ValidatedCaBundle")
      .field("certificate_count", &self.certificate_count)
      .field("snapshot_id", &self.snapshot_id)
      .finish_non_exhaustive()
  }
}

impl ValidatedCaBundle {
  /// Process-owned immutable materialization for libraries requiring a CA file.
  /// The owning bundle must outlive every transport or subprocess using it.
  pub fn materialized_path(&self) -> &Path {
    self.materialized.path()
  }
  pub fn pem(&self) -> &[u8] {
    &self.pem
  }
  /// Validated DER anchors, parsed once from the startup input.
  pub fn certificates(&self) -> &[Vec<u8>] {
    &self.certificates
  }
}

pub fn validate_relative_path(path: &str) -> Result<(), String> {
  let path = path.trim();
  if path.is_empty() {
    return Ok(());
  }
  let path = Path::new(path);
  if path.is_absolute()
    || path.components().any(|component| {
      matches!(
        component,
        Component::ParentDir | Component::RootDir | Component::Prefix(_)
      )
    })
  {
    return Err(
      "git_sync.https_ca_bundle_path must be a relative path inside the active runtime-config directory".to_string(),
    );
  }
  Ok(())
}

pub fn resolve_below_root(root: &Path, configured: &str) -> Result<PathBuf, String> {
  validate_relative_path(configured)?;
  let canonical_root = root
    .canonicalize()
    .map_err(|error| format!("could not access the server config directory: {error}"))?;
  let canonical_candidate = canonical_root
    .join(configured)
    .canonicalize()
    .map_err(|error| format!("could not access the configured Git-Sync CA bundle: {error}"))?;
  if !canonical_candidate.starts_with(&canonical_root) {
    return Err("git_sync.https_ca_bundle_path resolves outside the active runtime-config directory".to_string());
  }
  if !canonical_candidate.is_file() {
    return Err("git_sync.https_ca_bundle_path must resolve to a regular file".to_string());
  }
  Ok(canonical_candidate)
}

pub fn validate_bundle(path: &Path) -> Result<usize, String> {
  let bytes =
    std::fs::read(path).map_err(|error| format!("could not read the configured Git-Sync CA bundle: {error}"))?;
  validate_pem(&bytes).map(|certificates| certificates.len())
}

pub(crate) fn validate_pem(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
  parse_ca_pem(bytes, true)
}

/// Inspection may report expired CA metadata; activation always requires current validity.
pub(crate) fn parse_ca_pem(bytes: &[u8], require_current: bool) -> Result<Vec<Vec<u8>>, String> {
  use x509_parser::prelude::FromDer;
  if bytes.is_empty() {
    return Err("the configured Git-Sync CA bundle is empty".to_string());
  }
  let text = std::str::from_utf8(&bytes)
    .map_err(|_| "the configured Git-Sync CA bundle must be PEM-encoded UTF-8".to_string())?;
  let blocks =
    pem::parse_many(&bytes).map_err(|_| "the configured Git-Sync CA bundle contains malformed PEM".to_string())?;
  let begin_markers = text.matches("-----BEGIN ").count();
  let end_markers = text.matches("-----END ").count();
  if blocks.is_empty() || begin_markers != blocks.len() || end_markers != blocks.len() {
    return Err("the configured Git-Sync CA bundle contains malformed or incomplete PEM".to_string());
  }
  for (index, block) in blocks.iter().enumerate() {
    if block.tag() != "CERTIFICATE" {
      return Err(format!(
        "the configured Git-Sync CA bundle entry {} is not a CERTIFICATE block",
        index + 1
      ));
    }
    let (remaining, certificate) =
      x509_parser::certificate::X509Certificate::from_der(block.contents()).map_err(|_| {
        format!(
          "the configured Git-Sync CA bundle entry {} is not a valid X.509 certificate",
          index + 1
        )
      })?;
    if !remaining.is_empty() {
      return Err(format!(
        "the configured Git-Sync CA bundle entry {} contains trailing DER data",
        index + 1
      ));
    }
    if !certificate.tbs_certificate.is_ca() {
      return Err(format!(
        "the configured Git-Sync CA bundle entry {} is not a CA certificate",
        index + 1
      ));
    }
    if require_current && !certificate.validity().is_valid() {
      return Err(format!(
        "the configured Git-Sync CA bundle entry {} is not currently valid",
        index + 1
      ));
    }
  }
  Ok(blocks.into_iter().map(|block| block.into_contents()).collect())
}

/// Load and validate a bundle without changing any process-wide transport state.
pub fn load_bundle(root: &Path, configured: &str) -> Result<Option<ValidatedCaBundle>, String> {
  let configured = configured.trim();
  if configured.is_empty() {
    return Ok(None);
  }
  let canonical_path = resolve_below_root(root, configured)?;
  let bytes = std::fs::read(&canonical_path).map_err(|_| "configured CA bundle could not be read".to_string())?;
  let certificates = validate_pem(&bytes)?;
  let certificate_count = certificates.len();
  let snapshot_id = hex::encode(Sha256::digest(&bytes));
  let mut materialized =
    tempfile::NamedTempFile::new().map_err(|_| "CA snapshot could not be materialized".to_string())?;
  materialized
    .write_all(&bytes)
    .map_err(|_| "CA snapshot could not be materialized".to_string())?;
  materialized
    .flush()
    .map_err(|_| "CA snapshot could not be materialized".to_string())?;
  Ok(Some(ValidatedCaBundle {
    canonical_path,
    certificate_count,
    snapshot_id,
    pem: bytes.into(),
    certificates: certificates.into(),
    materialized: Arc::new(materialized),
  }))
}

/// Extend the client's existing public trust without changing transport policy.
pub fn add_reqwest_roots(
  mut builder: reqwest::ClientBuilder,
  bundle: &ValidatedCaBundle,
) -> Result<reqwest::ClientBuilder, String> {
  for der in bundle.certificates() {
    let certificate = reqwest::Certificate::from_der(der)
      .map_err(|_| "configured CA bundle could not be loaded for HTTP".to_string())?;
    builder = builder.add_root_certificate(certificate);
  }
  Ok(builder)
}

/// Build a consumer-specific HTTP client with the immutable startup trust.
/// Timeout, redirect and authentication policies remain owned by the caller.
pub fn build_http_client(
  builder: reqwest::ClientBuilder,
  bundle: Option<&ValidatedCaBundle>,
) -> Result<reqwest::Client, String> {
  initialize_crypto_provider();
  let builder = builder.dns_resolver(Arc::new(http_error::SystemResolver));
  let builder = match bundle {
    Some(bundle) => add_reqwest_roots(builder, bundle)?,
    None => builder,
  };
  builder
    .build()
    .map_err(|_| "TLS HTTP client initialization failed".to_string())
}
