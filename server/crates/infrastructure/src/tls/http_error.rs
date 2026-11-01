// SPDX-License-Identifier: AGPL-3.0-or-later
//! Allowlisted transport diagnoses; error text and request URLs are never copied.

use std::{error::Error, fmt};

#[derive(Debug)]
pub struct DnsLookupError(std::io::Error);

impl fmt::Display for DnsLookupError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("DNS lookup failed")
  }
}
impl Error for DnsLookupError {
  fn source(&self) -> Option<&(dyn Error + 'static)> {
    Some(&self.0)
  }
}

/// Keep the system resolver used by reqwest's default GAI path, but retain a
/// typed phase boundary instead of recognizing DNS by platform-specific text.
#[derive(Debug)]
pub(super) struct SystemResolver;
impl reqwest::dns::Resolve for SystemResolver {
  fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
    let hostname = name.as_str().to_owned();
    Box::pin(async move {
      let addresses = tokio::net::lookup_host((hostname, 0))
        .await
        .map_err(|error| Box::new(DnsLookupError(error)) as Box<dyn Error + Send + Sync>)?;
      Ok(Box::new(addresses) as reqwest::dns::Addrs)
    })
  }
}

/// Inspect a bounded typed chain, including Rustls wrapped in io::Error.
/// Unknown errors intentionally collapse to a stable category, never Display.
pub fn reason(error: &reqwest::Error) -> &'static str {
  if let Some(reason) = chain_reason(error) {
    return reason;
  }
  if error.is_timeout() {
    "timeout"
  } else if error.is_connect() {
    "connection_failed"
  } else if error.is_decode() {
    "invalid_response"
  } else if error.is_status() {
    "http_rejected"
  } else {
    "request_failed"
  }
}

fn chain_reason(error: &(dyn Error + 'static)) -> Option<&'static str> {
  let mut pending = vec![error];
  for _ in 0..16 {
    let Some(error) = pending.pop() else {
      break;
    };
    if error.is::<DnsLookupError>() {
      return Some("dns_failed");
    }
    if let Some(tls) = error.downcast_ref::<rustls::Error>() {
      return Some(match tls {
        rustls::Error::InvalidCertificate(certificate) => match certificate {
          rustls::CertificateError::UnknownIssuer => "tls_unknown_issuer",
          rustls::CertificateError::NotValidForName | rustls::CertificateError::NotValidForNameContext { .. } => {
            "tls_hostname_mismatch"
          }
          rustls::CertificateError::Expired | rustls::CertificateError::ExpiredContext { .. } => {
            "tls_certificate_expired"
          }
          rustls::CertificateError::NotValidYet | rustls::CertificateError::NotValidYetContext { .. } => {
            "tls_certificate_not_yet_valid"
          }
          _ => "tls_certificate_rejected",
        },
        _ => "tls_handshake_failed",
      });
    }
    if let Some(source) = error.source() {
      pending.push(source);
    }
    if let Some(inner) = error.downcast_ref::<std::io::Error>().and_then(std::io::Error::get_ref) {
      pending.push(inner);
    }
  }
  None
}

/// Shared with SMTP's phase classifier; both adapters recognize the same
/// nested Rustls certificate failures without inspecting arbitrary messages.
pub(crate) fn certificate_rejected(error: &(dyn Error + 'static)) -> bool {
  matches!(
    chain_reason(error),
    Some(
      "tls_unknown_issuer"
        | "tls_hostname_mismatch"
        | "tls_certificate_expired"
        | "tls_certificate_not_yet_valid"
        | "tls_certificate_rejected"
    )
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn typed_ca_and_dns_causes_do_not_render_secret_bearing_errors() {
    for (certificate, expected) in [
      (rustls::CertificateError::UnknownIssuer, "tls_unknown_issuer"),
      (rustls::CertificateError::NotValidForName, "tls_hostname_mismatch"),
      (rustls::CertificateError::Expired, "tls_certificate_expired"),
    ] {
      let wrapped = std::io::Error::other(rustls::Error::InvalidCertificate(certificate));
      assert_eq!(chain_reason(&wrapped), Some(expected));
    }
    let dns = DnsLookupError(std::io::Error::other(
      "https://user:secret@idp.test/?code=secret&token=secret",
    ));
    assert_eq!(chain_reason(&dns), Some("dns_failed"));
    assert_eq!(dns.to_string(), "DNS lookup failed");
    assert_eq!(
      chain_reason(&std::io::Error::other("token=secret PEM cookie=secret")),
      None
    );
  }
}
