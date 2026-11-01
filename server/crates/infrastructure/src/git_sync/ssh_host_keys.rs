// SPDX-License-Identifier: AGPL-3.0-or-later
//! SSH host-key policy support for Git-Sync.
//!
//! libgit2 invokes certificate callbacks from blocking Git transport code. The
//! database, however, is async. This module therefore splits the problem into a
//! pure decision step that can run inside the callback and an async persistence
//! step that stores newly accepted keys after the transport callback has seen
//! them.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tracing::warn;
use uuid::Uuid;

use myoxus_application::git_sync::{GitError, SshHostKeyPolicy};

/// A persisted SSH host key pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSyncSshHostKey {
  pub host: String,
  pub port: i32,
  pub key_type: String,
  pub fingerprint_sha256: String,
  pub first_seen_at: DateTime<Utc>,
  pub last_seen_at: DateTime<Utc>,
  pub source: String,
  pub created_by: Option<Uuid>,
  pub enabled: bool,
}

/// SSH endpoint extracted from a Git remote URL or callback hostname.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SshRemoteEndpoint {
  pub host: String,
  pub port: i32,
}

impl SshRemoteEndpoint {
  pub fn new(host: impl Into<String>, port: i32) -> Result<Self, GitError> {
    let host = normalize_host(&host.into()).ok_or_else(|| GitError::Network("SSH host is empty".to_string()))?;
    if !(1..=65535).contains(&port) {
      return Err(GitError::Network(format!("invalid SSH port: {port}")));
    }
    Ok(Self { host, port })
  }
}

/// A host key observed by the git2 certificate callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedSshHostKey {
  pub host: String,
  pub port: i32,
  pub key_type: String,
  pub fingerprint_sha256: String,
  pub source: String,
  pub created_by: Option<Uuid>,
}

/// Runtime context for SSH host-key verification.
#[derive(Debug, Clone)]
pub struct SshHostKeyRuntime {
  pub policy: SshHostKeyPolicy,
  pub source: String,
  pub created_by: Option<Uuid>,
}

/// Prepared synchronous verifier state used by git2 callbacks.
#[derive(Debug, Clone)]
pub struct PreparedSshHostKeyCheck {
  endpoint: SshRemoteEndpoint,
  runtime: SshHostKeyRuntime,
  known_keys: Vec<GitSyncSshHostKey>,
  observed: Arc<Mutex<Vec<ObservedSshHostKey>>>,
}

impl PreparedSshHostKeyCheck {
  pub fn new(endpoint: SshRemoteEndpoint, runtime: SshHostKeyRuntime, known_keys: Vec<GitSyncSshHostKey>) -> Self {
    Self {
      endpoint,
      runtime,
      known_keys,
      observed: Arc::new(Mutex::new(Vec::new())),
    }
  }

  pub fn observed(&self) -> Vec<ObservedSshHostKey> {
    self.observed.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  pub fn check_host_key(
    &self,
    callback_hostname: &str,
    key_type: &str,
    fingerprint_sha256: &str,
  ) -> Result<SshHostKeyDecision, GitError> {
    let endpoint = callback_endpoint(callback_hostname, &self.endpoint)?;
    let candidate = ObservedSshHostKey {
      host: endpoint.host,
      port: endpoint.port,
      key_type: key_type.to_string(),
      fingerprint_sha256: fingerprint_sha256.to_string(),
      source: self.runtime.source.clone(),
      created_by: self.runtime.created_by,
    };
    let decision = decide_ssh_host_key(self.runtime.policy, &self.known_keys, &candidate)?;
    if matches!(decision, SshHostKeyDecision::AcceptAndRecord) {
      self.observed.lock().unwrap_or_else(|e| e.into_inner()).push(candidate);
    }
    Ok(decision)
  }
}

/// Security decision for an observed SSH host key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshHostKeyDecision {
  AcceptKnown,
  AcceptAndRecord,
  AcceptInsecure,
}

pub fn decide_ssh_host_key(
  policy: SshHostKeyPolicy,
  known_keys: &[GitSyncSshHostKey],
  observed: &ObservedSshHostKey,
) -> Result<SshHostKeyDecision, GitError> {
  if policy == SshHostKeyPolicy::InsecureNoVerify {
    warn!(
      host = %observed.host,
      port = observed.port,
      key_type = %observed.key_type,
      "git-sync SSH host key verification is disabled by explicit policy"
    );
    return Ok(SshHostKeyDecision::AcceptInsecure);
  }

  let matching_slot = known_keys.iter().find(|key| {
    key.enabled && key.host == observed.host && key.port == observed.port && key.key_type == observed.key_type
  });

  match matching_slot {
    Some(key) if key.fingerprint_sha256 == observed.fingerprint_sha256 => Ok(SshHostKeyDecision::AcceptKnown),
    Some(key) => Err(GitError::Network(format!(
      "SSH host key mismatch for {}:{} ({}) — expected {}, got {}",
      observed.host, observed.port, observed.key_type, key.fingerprint_sha256, observed.fingerprint_sha256
    ))),
    None if policy == SshHostKeyPolicy::AcceptNew => Ok(SshHostKeyDecision::AcceptAndRecord),
    None => Err(GitError::Network(format!(
      "SSH host key for {}:{} ({}) is unknown and git_sync.ssh_host_key_policy is strict",
      observed.host, observed.port, observed.key_type
    ))),
  }
}

pub fn fingerprint_sha256(raw_key: &[u8]) -> String {
  let digest = Sha256::digest(raw_key);
  format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

pub fn fingerprint_sha256_from_digest(digest: &[u8; 32]) -> String {
  format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

pub fn normalize_host(input: &str) -> Option<String> {
  let host = input.trim().trim_matches('[').trim_matches(']').to_ascii_lowercase();
  if host.is_empty() { None } else { Some(host) }
}

pub fn ssh_endpoint_from_repo_url(repo_url: &str) -> Option<SshRemoteEndpoint> {
  let repo_url = repo_url.trim();
  if let Some(rest) = repo_url.strip_prefix("ssh://") {
    let authority = rest.split('/').next().unwrap_or_default();
    let without_user = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = split_host_port(without_user, 22);
    return SshRemoteEndpoint::new(host, port).ok();
  }

  // scp-style syntax: git@example.org:owner/repo.git
  if let Some((authority, _path)) = repo_url.split_once(':')
    && authority.contains('@')
    && !authority.contains('/')
  {
    let host = authority.rsplit('@').next().unwrap_or(authority);
    return SshRemoteEndpoint::new(host, 22).ok();
  }

  None
}

fn split_host_port(authority: &str, default_port: i32) -> (&str, i32) {
  if authority.starts_with('[')
    && let Some((host, rest)) = authority.split_once(']')
  {
    let port = rest
      .strip_prefix(':')
      .and_then(|p| p.parse::<i32>().ok())
      .unwrap_or(default_port);
    return (host.trim_start_matches('['), port);
  }

  match authority.rsplit_once(':') {
    Some((host, port)) if !host.contains(':') => (host, port.parse::<i32>().unwrap_or(default_port)),
    _ => (authority, default_port),
  }
}

fn callback_endpoint(callback_hostname: &str, fallback: &SshRemoteEndpoint) -> Result<SshRemoteEndpoint, GitError> {
  match normalize_host(callback_hostname) {
    Some(host) => SshRemoteEndpoint::new(host, fallback.port),
    None => Ok(fallback.clone()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn known(fingerprint: &str, enabled: bool) -> GitSyncSshHostKey {
    GitSyncSshHostKey {
      host: "git.example.test".to_string(),
      port: 22,
      key_type: "ssh-ed25519".to_string(),
      fingerprint_sha256: fingerprint.to_string(),
      first_seen_at: Utc::now(),
      last_seen_at: Utc::now(),
      source: "test".to_string(),
      created_by: None,
      enabled,
    }
  }

  fn observed(fingerprint: &str) -> ObservedSshHostKey {
    ObservedSshHostKey {
      host: "git.example.test".to_string(),
      port: 22,
      key_type: "ssh-ed25519".to_string(),
      fingerprint_sha256: fingerprint.to_string(),
      source: "test".to_string(),
      created_by: None,
    }
  }

  #[test]
  fn inv_gsh15_accept_new_records_unknown_and_rejects_changed_fingerprint() {
    assert_eq!(
      decide_ssh_host_key(SshHostKeyPolicy::AcceptNew, &[], &observed("SHA256:first")).unwrap(),
      SshHostKeyDecision::AcceptAndRecord
    );

    let err = decide_ssh_host_key(
      SshHostKeyPolicy::AcceptNew,
      &[known("SHA256:first", true)],
      &observed("SHA256:changed"),
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("host key mismatch"), "unexpected error: {err}");
  }

  #[test]
  fn inv_gsh15_strict_requires_enabled_known_key() {
    let err = decide_ssh_host_key(SshHostKeyPolicy::Strict, &[], &observed("SHA256:first"))
      .unwrap_err()
      .to_string();
    assert!(err.contains("unknown"), "unexpected error: {err}");

    assert_eq!(
      decide_ssh_host_key(
        SshHostKeyPolicy::Strict,
        &[known("SHA256:first", true)],
        &observed("SHA256:first"),
      )
      .unwrap(),
      SshHostKeyDecision::AcceptKnown
    );

    assert!(
      decide_ssh_host_key(
        SshHostKeyPolicy::Strict,
        &[known("SHA256:first", false)],
        &observed("SHA256:first"),
      )
      .is_err()
    );
  }

  #[test]
  fn inv_gsh15_insecure_policy_is_explicit_and_does_not_record() {
    assert_eq!(
      decide_ssh_host_key(SshHostKeyPolicy::InsecureNoVerify, &[], &observed("SHA256:any")).unwrap(),
      SshHostKeyDecision::AcceptInsecure
    );
  }

  #[test]
  fn inv_gsh15_ssh_url_endpoint_parser_handles_ssh_and_scp_forms() {
    assert_eq!(
      ssh_endpoint_from_repo_url("ssh://git@[2001:db8::1]:2222/acme/repo.git").unwrap(),
      SshRemoteEndpoint {
        host: "2001:db8::1".to_string(),
        port: 2222,
      }
    );
    assert_eq!(
      ssh_endpoint_from_repo_url("git@Git.Example.Test:acme/repo.git").unwrap(),
      SshRemoteEndpoint {
        host: "git.example.test".to_string(),
        port: 22,
      }
    );
    assert!(ssh_endpoint_from_repo_url("https://git.example.test/acme/repo.git").is_none());
  }
}
