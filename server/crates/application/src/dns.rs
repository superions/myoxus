//! Shared DNS validation helpers.
//!
//! Provides reusable async DNS lookups (MX, SPF, DMARC) for:
//! - Email domain verification (`auth.requireEmailDomainVerification`)
//! - Git-sync host reachability checks (future)
//!
//! Uses `hickory-resolver` for pure-Rust async DNS resolution.
//! All checks are **fail-open**: DNS failures log a warning but do NOT
//! block the operation, to avoid false positives from transient DNS issues.

use std::time::Duration;

use hickory_resolver::Resolver;
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use tracing::{debug, info, instrument, warn};

/// Result of validating an email domain's DNS records.
#[derive(Debug, Clone)]
pub struct DomainValidationResult {
  pub domain: String,
  pub has_mx: bool,
  pub has_spf: bool,
  pub has_dmarc: bool,
  /// `true` if all required records exist.
  pub valid: bool,
  /// Human-readable reason if invalid.
  pub reason: Option<String>,
}

/// Validate that an email domain has proper MX, SPF, and DMARC records.
///
/// **Fail-open**: DNS resolution errors (timeout, SERVFAIL, network issues)
/// are treated as "record exists" to avoid blocking legitimate users due
/// to transient DNS problems.  A warning is logged for each failed lookup.
///
/// # Arguments
/// - `domain` — the email domain to check (e.g. `"example.com"`)
/// - `timeout_seconds` — per-query DNS timeout
#[instrument(skip_all)]
pub async fn validate_email_domain(domain: &str, timeout_seconds: u64) -> DomainValidationResult {
  // Wrap the entire DNS validation in a total timeout to prevent hangs
  // in Docker bridge networks where hickory_resolver's default resolver
  // config may not reach the host DNS.
  let total_timeout = Duration::from_secs(timeout_seconds.saturating_mul(3).max(10));
  match tokio::time::timeout(total_timeout, validate_email_domain_inner(domain, timeout_seconds)).await {
    Ok(result) => result,
    Err(_) => {
      warn!(
        domain,
        total_timeout_secs = total_timeout.as_secs(),
        "DNS validation timed out completely (fail-open: treating as valid)"
      );
      DomainValidationResult {
        domain: domain.to_string(),
        has_mx: true,
        has_spf: true,
        has_dmarc: true,
        valid: true,
        reason: None,
      }
    }
  }
}

/// Inner implementation of email domain validation (wrapped by total timeout).
async fn validate_email_domain_inner(domain: &str, timeout_seconds: u64) -> DomainValidationResult {
  let mut opts = ResolverOpts::default();
  opts.timeout = Duration::from_secs(timeout_seconds);
  opts.attempts = 2;

  let resolver = match Resolver::builder_with_config(ResolverConfig::default(), TokioRuntimeProvider::default())
    .with_options(opts)
    .build()
  {
    Ok(resolver) => resolver,
    Err(error) => {
      warn!(domain, error = %error, "DNS resolver initialization failed (fail-open: treating as valid)");
      return DomainValidationResult {
        domain: domain.to_string(),
        has_mx: true,
        has_spf: true,
        has_dmarc: true,
        valid: true,
        reason: None,
      };
    }
  };

  // MX lookup (with per-query timeout)
  let has_mx = match tokio::time::timeout(Duration::from_secs(timeout_seconds), resolver.mx_lookup(domain)).await {
    Ok(Ok(mx)) => {
      let exchanges: Vec<String> = mx
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
          RData::MX(value) => Some(value.exchange.to_string()),
          _ => None,
        })
        .filter(|e| !e.is_empty() && e != ".")
        .collect();
      debug!(domain, mx_count = exchanges.len(), "MX lookup complete");
      !exchanges.is_empty()
    }
    Ok(Err(e)) => {
      warn!(domain, error = %e, "MX lookup failed (fail-open: treating as valid)");
      true // fail-open
    }
    Err(_) => {
      warn!(domain, "MX lookup timed out (fail-open: treating as valid)");
      true // fail-open
    }
  };

  // SPF lookup (TXT records containing "v=spf1")
  let has_spf = match tokio::time::timeout(Duration::from_secs(timeout_seconds), resolver.txt_lookup(domain)).await {
    Ok(Ok(txt)) => {
      let spf_records: Vec<String> = txt
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
          RData::TXT(value) => Some(value.to_string()),
          _ => None,
        })
        .filter(|t| t.contains("v=spf1"))
        .collect();
      debug!(domain, spf_count = spf_records.len(), "SPF lookup complete");
      !spf_records.is_empty()
    }
    Ok(Err(e)) => {
      warn!(domain, error = %e, "SPF lookup failed (fail-open: treating as valid)");
      true // fail-open
    }
    Err(_) => {
      warn!(domain, "SPF lookup timed out (fail-open: treating as valid)");
      true // fail-open
    }
  };

  // DMARC lookup (TXT records on _dmarc.<domain> containing "v=DMARC1")
  let dmarc_domain = format!("_dmarc.{domain}");
  let has_dmarc = match tokio::time::timeout(
    Duration::from_secs(timeout_seconds),
    resolver.txt_lookup(dmarc_domain.as_str()),
  )
  .await
  {
    Ok(Ok(txt)) => {
      let dmarc_records: Vec<String> = txt
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
          RData::TXT(value) => Some(value.to_string()),
          _ => None,
        })
        .filter(|t| t.contains("v=DMARC1"))
        .collect();
      debug!(domain, dmarc_count = dmarc_records.len(), "DMARC lookup complete");
      !dmarc_records.is_empty()
    }
    Ok(Err(e)) => {
      warn!(domain, error = %e, "DMARC lookup failed (fail-open: treating as valid)");
      true // fail-open
    }
    Err(_) => {
      warn!(domain, "DMARC lookup timed out (fail-open: treating as valid)");
      true // fail-open
    }
  };

  let valid = has_mx && has_spf && has_dmarc;
  let reason = if valid {
    None
  } else {
    let mut missing = Vec::new();
    if !has_mx {
      missing.push("MX");
    }
    if !has_spf {
      missing.push("SPF");
    }
    if !has_dmarc {
      missing.push("DMARC");
    }
    Some(format!(
      "email domain '{domain}' is missing required DNS records: {}",
      missing.join(", ")
    ))
  };

  info!(
    domain,
    has_mx, has_spf, has_dmarc, valid, "email domain DNS validation complete"
  );

  DomainValidationResult {
    domain: domain.to_string(),
    has_mx,
    has_spf,
    has_dmarc,
    valid,
    reason,
  }
}

/// Check whether a host is resolvable (has at least one A/AAAA record).
///
/// Useful for git-sync host reachability validation before configuring
/// a sync profile.  Fail-open: DNS errors return `true` with a warning.
#[instrument(skip_all)]
pub async fn is_host_resolvable(host: &str, timeout_seconds: u64) -> bool {
  let mut opts = ResolverOpts::default();
  opts.timeout = Duration::from_secs(timeout_seconds);
  opts.attempts = 2;

  let resolver = match Resolver::builder_with_config(ResolverConfig::default(), TokioRuntimeProvider::default())
    .with_options(opts)
    .build()
  {
    Ok(resolver) => resolver,
    Err(error) => {
      warn!(host, error = %error, "DNS resolver initialization failed (fail-open: treating as reachable)");
      return true;
    }
  };

  // Wrap in a total timeout to prevent hangs in Docker bridge networks
  match tokio::time::timeout(
    Duration::from_secs(timeout_seconds.saturating_mul(2).max(5)),
    resolver.lookup_ip(host),
  )
  .await
  {
    Ok(Ok(ips)) => {
      let count = ips.iter().count();
      debug!(host, ip_count = count, "host resolution complete");
      count > 0
    }
    Ok(Err(e)) => {
      warn!(host, error = %e, "host resolution failed (fail-open: treating as reachable)");
      true // fail-open
    }
    Err(_) => {
      warn!(host, "host resolution timed out (fail-open: treating as reachable)");
      true // fail-open
    }
  }
}

/// Validate an email address for domain verification requirements.
///
/// Returns `Err(reason)` if the email is invalid for signup:
/// - Plus-aliases (`user+tag@domain.com`) are rejected
/// - Domain must have MX, SPF, DMARC records (fail-open on DNS errors)
/// - If `allowed_domains` is non-empty, domain must be in the whitelist
///
/// Returns `Ok(())` if the email passes all checks.
#[instrument(skip_all)]
pub async fn validate_email_for_signup(
  email: &str,
  allowed_domains: &[String],
  dns_timeout_seconds: u64,
) -> Result<(), String> {
  // Extract domain
  let parts: Vec<&str> = email.split('@').collect();
  if parts.len() != 2 {
    return Err(format!("invalid email format: {email}"));
  }
  let local_part = parts[0];
  let domain = parts[1];

  if domain.is_empty() {
    return Err("email domain is empty".to_string());
  }

  // Reject plus-aliases
  if local_part.contains('+') {
    return Err(format!(
      "email aliases with '+' are not allowed when domain verification is enabled: {email}"
    ));
  }

  // Whitelist check (if configured)
  if !allowed_domains.is_empty() {
    let domain_lower = domain.to_lowercase();
    let in_whitelist = allowed_domains.iter().any(|d| d.to_lowercase() == domain_lower);
    if !in_whitelist {
      return Err(format!("email domain '{domain}' is not in the allowed domains list"));
    }
  }

  // DNS record validation
  let result = validate_email_domain(domain, dns_timeout_seconds).await;
  if !result.valid {
    return Err(
      result
        .reason
        .unwrap_or_else(|| format!("email domain '{domain}' failed DNS validation")),
    );
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_plus_alias() {
    let rt = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let result = rt.block_on(validate_email_for_signup("user+tag@example.com", &[], 5));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("aliases with '+'"));
  }

  #[test]
  fn rejects_invalid_email_format() {
    let rt = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let result = rt.block_on(validate_email_for_signup("no-at-sign", &[], 5));
    assert!(result.is_err());
  }

  #[test]
  fn rejects_domain_not_in_whitelist() {
    let rt = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let allowed = vec!["company.com".to_string()];
    let result = rt.block_on(validate_email_for_signup("user@other.com", &allowed, 5));
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not in the allowed domains"));
  }

  #[test]
  fn accepts_domain_in_whitelist() {
    let rt = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let allowed = vec!["company.com".to_string()];
    // DNS will fail-open in test environment, so this should pass
    let result = rt.block_on(validate_email_for_signup("user@company.com", &allowed, 1));
    assert!(result.is_ok(), "whitelist match should pass: {:?}", result);
  }
}
