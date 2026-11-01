// SPDX-License-Identifier: AGPL-3.0-or-later

use std::net::IpAddr;

use url::Url;

/// Schemes that may appear in PDF hyperlinks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkScheme {
  Https,
  Http,
  Mailto,
  Tel,
}

/// A hyperlink that has passed all validation checks.
#[derive(Debug, Clone)]
pub struct ValidatedLink {
  /// Normalised href (whitespace stripped, scheme lowercased by the `url` parser).
  pub href: String,
  pub scheme: LinkScheme,
  /// Original trimmed input — used in error messages and display contexts.
  pub display: String,
}

/// All reasons a link can be rejected before embedding in a PDF.
#[derive(Debug, thiserror::Error)]
pub enum LinkValidationError {
  #[error("unsupported scheme: {0}")]
  UnsupportedScheme(String),
  #[error("disallowed host: {0}")]
  DisallowedHost(String),
  #[error("invalid URL: {0}")]
  InvalidUrl(String),
}

const EXPLICITLY_BLOCKED_SCHEMES: &[&str] = &[
  "javascript",
  "data",
  "vbscript",
  "file",
  "ftp",
  "gopher",
  "chrome",
  "chrome-extension",
];

/// Validates a user-authored hyperlink for safe embedding in a PDF.
///
/// Returns a [`ValidatedLink`] on success, or a [`LinkValidationError`] describing
/// exactly why the href was rejected.
pub fn validate_link(href: &str) -> Result<ValidatedLink, LinkValidationError> {
  let trimmed = href.trim();

  if trimmed.is_empty() {
    return Err(LinkValidationError::InvalidUrl("empty".into()));
  }

  // Lowercase only the scheme portion so we can compare it before full parsing.
  // `url::Url` already normalises the scheme internally, but we need to detect
  // blocked schemes that the url crate might parse successfully (e.g. `javascript:`).
  let scheme_end = trimmed
    .find(':')
    .ok_or_else(|| LinkValidationError::InvalidUrl(trimmed.to_owned()))?;
  let raw_scheme = trimmed[..scheme_end].to_ascii_lowercase();

  if EXPLICITLY_BLOCKED_SCHEMES.contains(&raw_scheme.as_str()) {
    return Err(LinkValidationError::UnsupportedScheme(raw_scheme));
  }

  match raw_scheme.as_str() {
    "https" | "http" => validate_http_link(trimmed, &raw_scheme),
    "mailto" => validate_mailto(trimmed),
    "tel" => validate_tel(trimmed),
    other => Err(LinkValidationError::UnsupportedScheme(other.to_owned())),
  }
}

fn validate_http_link(href: &str, raw_scheme: &str) -> Result<ValidatedLink, LinkValidationError> {
  let parsed = Url::parse(href).map_err(|e| LinkValidationError::InvalidUrl(e.to_string()))?;

  let host = parsed
    .host_str()
    .ok_or_else(|| LinkValidationError::InvalidUrl("missing host".into()))?;

  reject_disallowed_host(host)?;

  let scheme = if raw_scheme == "https" {
    LinkScheme::Https
  } else {
    LinkScheme::Http
  };

  Ok(ValidatedLink {
    href: parsed.to_string(),
    scheme,
    display: href.to_owned(),
  })
}

/// Rejects any host that could route to internal infrastructure.
fn reject_disallowed_host(host: &str) -> Result<(), LinkValidationError> {
  let lower = host.to_ascii_lowercase();

  // Reject by hostname patterns first — covers `localhost`, `*.local`, `*.internal`.
  if lower == "localhost"
    || lower.ends_with(".local")
    || lower == "local"
    || lower.ends_with(".internal")
    || lower == "internal"
  {
    return Err(LinkValidationError::DisallowedHost(host.to_owned()));
  }

  // Attempt IP parsing. Brackets are used for IPv6 literals in URLs.
  let ip_str = lower
    .strip_prefix('[')
    .and_then(|s| s.strip_suffix(']'))
    .unwrap_or(&lower);

  if let Ok(ip) = ip_str.parse::<IpAddr>()
    && is_disallowed_ip(ip)
  {
    return Err(LinkValidationError::DisallowedHost(host.to_owned()));
  }

  Ok(())
}

fn is_disallowed_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => {
      let o = v4.octets();
      // 127.0.0.0/8 — loopback
      if o[0] == 127 {
        return true;
      }
      // 0.0.0.0
      if o == [0, 0, 0, 0] {
        return true;
      }
      // RFC1918: 10.0.0.0/8
      if o[0] == 10 {
        return true;
      }
      // RFC1918: 172.16.0.0/12
      if o[0] == 172 && (16..=31).contains(&o[1]) {
        return true;
      }
      // RFC1918: 192.168.0.0/16
      if o[0] == 192 && o[1] == 168 {
        return true;
      }
      // CGNAT: 100.64.0.0/10
      if o[0] == 100 && (64..=127).contains(&o[1]) {
        return true;
      }
      false
    }
    IpAddr::V6(v6) => {
      // ::1 loopback
      if v6.is_loopback() {
        return true;
      }
      let segs = v6.segments();
      // fe80::/10 — link-local
      if segs[0] & 0xffc0 == 0xfe80 {
        return true;
      }
      // fc00::/7 — RFC4193 unique local
      if segs[0] & 0xfe00 == 0xfc00 {
        return true;
      }
      false
    }
  }
}

fn validate_mailto(href: &str) -> Result<ValidatedLink, LinkValidationError> {
  // Strip the scheme prefix, then check for `@` in the address portion.
  let address = href
    .get("mailto:".len()..)
    .unwrap_or("")
    .split('?')
    .next()
    .unwrap_or("");

  if !address.contains('@') {
    return Err(LinkValidationError::InvalidUrl("mailto: address missing '@'".into()));
  }

  Ok(ValidatedLink {
    href: href.to_owned(),
    scheme: LinkScheme::Mailto,
    display: href.to_owned(),
  })
}

fn validate_tel(href: &str) -> Result<ValidatedLink, LinkValidationError> {
  let number = href.get("tel:".len()..).unwrap_or("");

  if !is_valid_tel_number(number) {
    return Err(LinkValidationError::InvalidUrl(format!(
      "tel: number contains disallowed characters: {number}"
    )));
  }

  Ok(ValidatedLink {
    href: href.to_owned(),
    scheme: LinkScheme::Tel,
    display: href.to_owned(),
  })
}

/// Accepts `+`, digits, `-`, spaces, `(`, `)`, `.` — the common tel: character set.
/// Returns false for empty or any character outside that set.
fn is_valid_tel_number(number: &str) -> bool {
  if number.is_empty() {
    return false;
  }
  number
    .chars()
    .all(|c| matches!(c, '+' | '0'..='9' | '-' | ' ' | '(' | ')' | '.'))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn inv_link01_javascript_uri_rejected() {
    let result = validate_link("javascript:alert(1)");
    assert!(
      matches!(result, Err(LinkValidationError::UnsupportedScheme(s)) if s == "javascript"),
      "javascript: scheme must always be rejected"
    );
  }

  #[test]
  fn inv_link02_data_uri_rejected() {
    let result = validate_link("data:text/html,<h1>hi</h1>");
    assert!(
      matches!(result, Err(LinkValidationError::UnsupportedScheme(s)) if s == "data"),
      "data: scheme must always be rejected"
    );
  }

  #[test]
  fn inv_link03_https_passed() {
    let link = validate_link("https://example.com/path?q=1").expect("valid https link");
    assert_eq!(link.scheme, LinkScheme::Https);
    assert!(link.href.starts_with("https://"));
  }

  #[test]
  fn inv_link04_mailto_passed() {
    let link = validate_link("mailto:user@example.com").expect("valid mailto link");
    assert_eq!(link.scheme, LinkScheme::Mailto);
  }

  #[test]
  fn inv_link05_localhost_rejected() {
    for href in &[
      "http://localhost/secret",
      "http://localhost:8080/admin",
      "https://localhost/api",
    ] {
      assert!(
        matches!(validate_link(href), Err(LinkValidationError::DisallowedHost(_))),
        "{href} must be rejected as localhost"
      );
    }
  }

  #[test]
  fn inv_link06_rfc1918_rejected_for_each_range() {
    let cases = [
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.0.1/",
      "http://192.168.255.254/",
      "http://100.64.0.1/",
      "http://100.127.255.255/",
      "http://127.0.0.1/",
      "http://0.0.0.0/",
    ];
    for href in &cases {
      assert!(
        matches!(validate_link(href), Err(LinkValidationError::DisallowedHost(_))),
        "{href} must be rejected as private/reserved IP"
      );
    }
  }

  #[test]
  fn inv_link07_ipv6_loopback_rejected() {
    let cases = [
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
    ];
    for href in &cases {
      assert!(
        matches!(validate_link(href), Err(LinkValidationError::DisallowedHost(_))),
        "{href} must be rejected as internal IPv6"
      );
    }
  }

  #[test]
  fn inv_link08_internal_tld_rejected() {
    let cases = [
      "https://foo.internal/path",
      "https://bar.local/path",
      "https://internal/path",
      "https://local/path",
    ];
    for href in &cases {
      assert!(
        matches!(validate_link(href), Err(LinkValidationError::DisallowedHost(_))),
        "{href} must be rejected due to internal TLD"
      );
    }
  }

  #[test]
  fn inv_link09_tel_passes() {
    let link = validate_link("tel:+49-30-12345678").expect("valid tel link");
    assert_eq!(link.scheme, LinkScheme::Tel);
  }

  #[test]
  fn inv_link10_empty_rejected() {
    let result = validate_link("   ");
    assert!(
      matches!(result, Err(LinkValidationError::InvalidUrl(msg)) if msg == "empty"),
      "empty/whitespace-only href must be rejected"
    );
  }

  #[test]
  fn inv_link11_unicode_idn_passes_when_external() {
    // münchen.de is a real TLD registered to an external host — must pass.
    let link = validate_link("https://münchen.de/test").expect("unicode IDN must be accepted");
    assert_eq!(link.scheme, LinkScheme::Https);
  }

  #[test]
  fn inv_link12_uppercase_scheme_normalized() {
    // The url crate normalises the scheme to lowercase internally.
    let link = validate_link("HTTPS://example.com/").expect("uppercase scheme must be accepted");
    assert_eq!(link.scheme, LinkScheme::Https);
  }

  #[test]
  fn inv_link13_mailto_without_at_rejected() {
    let result = validate_link("mailto:not-an-email");
    assert!(
      matches!(result, Err(LinkValidationError::InvalidUrl(_))),
      "mailto: without '@' must be rejected"
    );
  }

  #[test]
  fn inv_link14_chrome_extension_scheme_rejected() {
    let result = validate_link("chrome-extension://abc/page.html");
    assert!(
      matches!(result, Err(LinkValidationError::UnsupportedScheme(s)) if s == "chrome-extension"),
      "chrome-extension: scheme must always be rejected"
    );
  }

  #[test]
  fn inv_link15_data_uri_with_base64_rejected() {
    let result = validate_link("data:image/png;base64,iVBORw0KGgo=");
    assert!(
      matches!(result, Err(LinkValidationError::UnsupportedScheme(s)) if s == "data"),
      "data: URI with base64 payload must be rejected"
    );
  }
}
