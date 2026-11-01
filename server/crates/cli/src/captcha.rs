// SPDX-License-Identifier: AGPL-3.0-or-later
//! `captcha` subcommand — HMAC key generation and status lookup.
//!
//! Two subcommands:
//!
//! * `generate-key` — emits a cryptographically random 32-byte key as a
//!   64-character hex string. Pipe the output into your deployment secrets
//!   (never commit to git) and set it as `MYOXUS__CAPTCHA__HMAC_KEY`.
//! * `status` — calls `GET /api/admin/captcha/status` on a running server
//!   and pretty-prints the feature-flag, algorithm, counters, and the
//!   `hmac_key_configured` boolean (never the key value itself).

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tabled::Tabled;

use crate::output::{print_json, print_output};

/// Subcommands for `captcha`.
#[derive(Subcommand)]
pub enum CaptchaCommand {
  /// Generate a new random HMAC key (32 bytes, hex-encoded) suitable for
  /// `MYOXUS__CAPTCHA__HMAC_KEY`. Output goes to stdout only — secrets MUST
  /// be stored outside the repository.
  GenerateKey,
  /// Query a running server's `/api/admin/captcha/status` endpoint.
  Status(StatusArgs),
}

/// Arguments for `captcha status`.
#[derive(Args)]
pub struct StatusArgs {
  /// Base URL of the running API server.
  #[arg(long, default_value = "http://localhost:3001")]
  pub url: String,

  /// Admin session cookie string, e.g. `session=…`. Required because the
  /// status endpoint rejects unauthenticated callers (INV-CAPTCHA-E).
  /// Retrieve it from your browser's DevTools after signing in as admin.
  #[arg(long, env = "MYOXUS_ADMIN_COOKIE")]
  pub cookie: String,
}

/// Row for the status table output.
#[derive(Tabled, Serialize)]
struct StatusRow {
  field: String,
  value: String,
}

/// Response shape mirrors `server/crates/api/src/handlers/captcha_admin.rs`
/// `CaptchaStatusResponse`. Deserialized into a raw map so schema additions on
/// the server side (new counters, …) do not break older CLIs.
#[derive(Deserialize)]
struct StatusResponse {
  enabled: bool,
  hmac_key_configured: bool,
  algorithm: String,
  challenge_expires_seconds: u64,
  verified_total: u64,
  rejected_total: u64,
  honeypot_total: u64,
  rate_limit_per_ip_per_min: u32,
  rate_limit_per_account_per_hour: u32,
}

pub async fn run(
  cmd: CaptchaCommand,
  json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<()> {
  match cmd {
    CaptchaCommand::GenerateKey => generate_key(json),
    CaptchaCommand::Status(args) => status(args, json, additional_ca).await,
  }
}

fn generate_key(json: bool) -> Result<()> {
  let mut bytes = [0u8; 32];
  rand::thread_rng().fill_bytes(&mut bytes);
  let hex = hex_encode(&bytes);
  if json {
    print_json(&serde_json::json!({ "hmac_key": hex }));
  } else {
    println!("{hex}");
  }
  Ok(())
}

async fn status(
  args: StatusArgs,
  json: bool,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<()> {
  let url = format!("{}/api/admin/captcha/status", args.url.trim_end_matches('/'));
  let resp = myoxus_infrastructure::tls::build_http_client(reqwest::Client::builder(), additional_ca)
    .map_err(anyhow::Error::msg)?
    .get(&url)
    .header("cookie", &args.cookie)
    .send()
    .await
    .with_context(|| format!("request to {url} failed"))?;
  let status = resp.status();
  if !status.is_success() {
    let text = resp.text().await.unwrap_or_default();
    anyhow::bail!("server returned {status}: {text}");
  }
  let body: StatusResponse = resp.json().await.context("invalid JSON body")?;
  let rows = vec![
    StatusRow {
      field: "enabled".into(),
      value: body.enabled.to_string(),
    },
    StatusRow {
      field: "hmac_key_configured".into(),
      value: body.hmac_key_configured.to_string(),
    },
    StatusRow {
      field: "algorithm".into(),
      value: body.algorithm,
    },
    StatusRow {
      field: "challenge_expires_seconds".into(),
      value: body.challenge_expires_seconds.to_string(),
    },
    StatusRow {
      field: "verified_total".into(),
      value: body.verified_total.to_string(),
    },
    StatusRow {
      field: "rejected_total".into(),
      value: body.rejected_total.to_string(),
    },
    StatusRow {
      field: "honeypot_total".into(),
      value: body.honeypot_total.to_string(),
    },
    StatusRow {
      field: "rate_limit_per_ip_per_min".into(),
      value: body.rate_limit_per_ip_per_min.to_string(),
    },
    StatusRow {
      field: "rate_limit_per_account_per_hour".into(),
      value: body.rate_limit_per_account_per_hour.to_string(),
    },
  ];
  print_output(&rows, json);
  Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
  const H: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for b in bytes {
    out.push(H[(*b >> 4) as usize] as char);
    out.push(H[(*b & 0x0f) as usize] as char);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn generate_key_is_64_hex_chars() {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex = hex_encode(&bytes);
    assert_eq!(hex.len(), 64);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
  }

  #[test]
  fn two_keys_differ() {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut a);
    rand::thread_rng().fill_bytes(&mut b);
    assert_ne!(hex_encode(&a), hex_encode(&b));
  }
}
