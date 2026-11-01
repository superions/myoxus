// SPDX-License-Identifier: AGPL-3.0-or-later
//! Redis uses a replacement root-store API, so retain its native roots explicitly.

use redis::{Client, ConnectionAddr, IntoConnectionInfo, TlsCertificates};

use super::ValidatedCaBundle;

/// Build one reusable client for a Redis role. Plaintext URLs are unchanged;
/// rediss keeps certificate and hostname verification enabled.
pub fn client(url: &str, bundle: Option<&ValidatedCaBundle>) -> Result<Client, String> {
  let info = url
    .into_connection_info()
    .map_err(|_| "invalid redis url".to_string())?;
  match info.addr() {
    ConnectionAddr::TcpTls { insecure: true, .. } => {
      return Err("insecure Redis TLS is not supported".into());
    }
    ConnectionAddr::TcpTls { .. } => {}
    _ => return Client::open(info).map_err(|_| "invalid redis configuration".into()),
  }
  let Some(bundle) = bundle else {
    return Client::open(info).map_err(|_| "invalid Redis TLS configuration".into());
  };
  // redis-rs normally loads this same native store. Its root_cert option
  // replaces, rather than extends, that store; supplying only our CA loses
  // public trust. The combined material is client-owned across reconnects.
  let native = rustls_native_certs_redis::load_native_certs();
  if !native.errors.is_empty() {
    return Err("Redis native trust store could not be loaded".to_string());
  }
  let mut roots = Vec::new();
  for der in native.certs {
    roots.extend_from_slice(pem::encode(&pem::Pem::new("CERTIFICATE", der.as_ref())).as_bytes());
  }
  roots.extend_from_slice(bundle.pem());
  Client::build_with_tls(
    info,
    TlsCertificates {
      client_tls: None,
      root_cert: Some(roots),
    },
  )
  .map_err(|_| "Redis TLS client initialization failed".to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plaintext_is_preserved_and_tls_verification_cannot_be_disabled() {
    let plain = client("redis://localhost:6379/2", None).expect("plaintext client");
    assert!(matches!(plain.get_connection_info().addr(), ConnectionAddr::Tcp(_, _)));
    assert_eq!(plain.get_connection_info().redis_settings().db(), 2);
    let tls = client("rediss://localhost:6380", None).expect("TLS client");
    assert!(matches!(
      tls.get_connection_info().addr(),
      ConnectionAddr::TcpTls { insecure: false, .. }
    ));
    assert!(client("rediss://localhost:6380/#insecure", None).is_err());
    let error = client("redis://user:secret@[invalid", None).expect_err("invalid URL");
    assert!(!error.contains("secret"));
  }
}
