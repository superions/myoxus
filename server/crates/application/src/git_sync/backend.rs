//! Git backend abstraction — port trait for Git repository operations.
//!
//! Single production implementation: git2/libgit2 in `myoxus-infrastructure`.
//! Designed as a trait for testability (mock/fake in integration tests).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::sync::Arc;

// ─── Auth ────────────────────────────────────────────────────────────────────

/// Authentication credentials for a remote Git repository.
///
/// **Security**: `Debug` is manually implemented to redact secrets.
/// Never derive `Debug` on this type.
#[derive(Clone)]
pub enum GitAuth {
  /// HTTPS with personal access token (e.g. GitHub PAT).
  HttpsToken { username: String, token: String },
  /// HTTPS with username + password.
  HttpsPassword { username: String, password: String },
  /// SSH private key (PEM-encoded).
  SshKey {
    private_key: Vec<u8>,
    passphrase: Option<String>,
  },
  /// No authentication (public repository).
  None,
}

impl fmt::Debug for GitAuth {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::HttpsToken { username, .. } => f
        .debug_struct("HttpsToken")
        .field("username", username)
        .field("token", &"[REDACTED]")
        .finish(),
      Self::HttpsPassword { username, .. } => f
        .debug_struct("HttpsPassword")
        .field("username", username)
        .field("password", &"[REDACTED]")
        .finish(),
      Self::SshKey { .. } => f
        .debug_struct("SshKey")
        .field("private_key", &"[REDACTED]")
        .field("passphrase", &"[REDACTED]")
        .finish(),
      Self::None => write!(f, "None"),
    }
  }
}

// ─── Changed files ───────────────────────────────────────────────────────────

/// A file that changed between two commits (or HEAD vs working tree).
#[derive(Debug, Clone)]
pub struct ChangedFile {
  pub path: String,
  pub change_type: ChangeType,
  /// Previous path, populated for renames.
  pub old_path: Option<String>,
}

/// Kind of change detected for a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeType {
  Added,
  Modified,
  Deleted,
  Renamed,
}

/// Server-observed result of updating one remote branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitRemoteRefStatus {
  Updated,
  AlreadyCurrent,
}

/// Evidence returned by the Git transport after the remote advertises the
/// branch ref following a push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushReceipt {
  pub branch: String,
  pub local_commit_oid: String,
  pub remote_ref_status: GitRemoteRefStatus,
  pub observed_remote_oid: String,
}

/// Read-only result of authenticating to a remote repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteProbe {
  /// Exact branch requested by the caller, when branch validation was part of
  /// the probe.
  pub branch: Option<String>,
  /// Advertised OID for `branch`; absent only for a connection-only probe.
  pub observed_remote_oid: Option<String>,
}

/// Verified local identity of the repository currently opened by the adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepositoryIdentity {
  pub workdir: std::path::PathBuf,
  pub origin_url: String,
  pub head_branch: String,
  pub head_oid: String,
  pub head_tree_oid: String,
}

impl fmt::Display for ChangeType {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Added => f.write_str("Added"),
      Self::Modified => f.write_str("Modified"),
      Self::Deleted => f.write_str("Deleted"),
      Self::Renamed => f.write_str("Renamed"),
    }
  }
}

impl fmt::Display for ChangedFile {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match &self.old_path {
      Some(old) => write!(f, "{}: {} (was {})", self.change_type, self.path, old),
      None => write!(f, "{}: {}", self.change_type, self.path),
    }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Errors from Git repository operations.
///
/// Classified to allow the sync engine to distinguish retryable failures
/// (network) from permanent ones (auth, conflict).
#[derive(Debug, thiserror::Error)]
pub enum GitError {
  #[error("authentication failed: {0}")]
  Auth(String),
  #[error("network error: {0}")]
  Network(String),
  #[error("TLS certificate verification failed: {0}")]
  Tls(String),
  #[error("repository error: {0}")]
  Repository(String),
  #[error("file not found: {0}")]
  NotFound(String),
  #[error("conflict: {0}")]
  Conflict(String),
  #[error("internal error: {0}")]
  Internal(String),
}

/// Opaque ownership retained by native Git writers until their blocking work
/// has actually stopped. Infrastructure supplies the concrete filesystem
/// guard; the application port deliberately knows neither its lock primitive
/// nor its path layout.
pub trait GitOperationGuard: fmt::Debug + Send + Sync {}

impl<T> GitOperationGuard for T where T: fmt::Debug + Send + Sync {}

impl From<std::io::Error> for GitError {
  fn from(e: std::io::Error) -> Self {
    Self::Internal(format!("I/O error: {e}"))
  }
}

/// SSH host-key verification mode for Git-Sync network transports.
///
/// The enum lives at the Git repository port boundary because both the API
/// config layer and the git2 infrastructure adapter must agree on the exact
/// values. `AcceptNew` is trust-on-first-use with persistent pinning; it is not
/// equivalent to disabling verification.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshHostKeyPolicy {
  /// Accept and persist an unknown host key, then require the same fingerprint
  /// on later connections.
  #[default]
  AcceptNew,
  /// Accept only keys that are already stored and enabled.
  Strict,
  /// Accept SSH host keys without verification. This is intentionally explicit
  /// and should only be used for short-lived diagnostics.
  InsecureNoVerify,
}

impl SshHostKeyPolicy {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::AcceptNew => "accept_new",
      Self::Strict => "strict",
      Self::InsecureNoVerify => "insecure_no_verify",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    match value.trim().to_ascii_lowercase().as_str() {
      "accept_new" => Some(Self::AcceptNew),
      "strict" => Some(Self::Strict),
      "insecure_no_verify" => Some(Self::InsecureNoVerify),
      _ => None,
    }
  }
}

/// HTTPS certificate-verification mode for Git-Sync network transports.
///
/// `InsecureNoVerify` is deliberately constrained by the server-owned
/// `allowedHosts` policy. The callback may only accept a failed X509 check
/// when the concrete callback hostname is present in a non-empty allowlist.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpsCertificatePolicy {
  /// Require libgit2's normal X509 verification.
  #[default]
  Strict,
  /// Accept an invalid X509 certificate only for an explicitly allowed host.
  InsecureNoVerify,
}

impl HttpsCertificatePolicy {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Strict => "strict",
      Self::InsecureNoVerify => "insecure_no_verify",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    match value.trim().to_ascii_lowercase().as_str() {
      "strict" => Some(Self::Strict),
      "insecure_no_verify" => Some(Self::InsecureNoVerify),
      _ => None,
    }
  }

  /// Decide whether a failed X509 check may be overridden.
  ///
  /// Hostname matching is case-insensitive and fails closed for an empty
  /// allowlist. This remains the shared decision for production sync and the
  /// GraphQL connection test, even if invalid configuration reaches runtime.
  pub fn allows_invalid_certificate(self, hostname: &str, allowed_hosts: &HashSet<String>) -> bool {
    self == Self::InsecureNoVerify
      && !allowed_hosts.is_empty()
      && allowed_hosts.contains(&hostname.trim().to_ascii_lowercase())
  }
}

/// Decide whether configured HTTPS credentials may be returned for the
/// concrete URL requested by libgit2.
///
/// libgit2 invokes the credential callback again after an HTTP redirect, so
/// validating only the profile's original repository URL is insufficient.
/// The existing `allowedHosts` semantics remain unchanged: an empty set allows
/// any syntactically valid HTTPS host, while a configured set is exact-host and
/// case-insensitive. Non-HTTPS, credential-bearing and unparsable callback URLs
/// fail closed.
pub fn allows_https_credential_target(target_url: &str, allowed_hosts: &HashSet<String>) -> bool {
  let Ok(target) = url::Url::parse(target_url) else {
    return false;
  };
  if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() {
    return false;
  }
  let Some(host) = target.host_str().map(|host| host.trim().to_ascii_lowercase()) else {
    return false;
  };
  allowed_hosts.is_empty() || allowed_hosts.contains(&host)
}

// ─── Port trait ──────────────────────────────────────────────────────────────

/// Abstraction over Git repository operations.
///
/// Single implementation: git2/libgit2.  Designed as a trait for testability.
///
/// All methods are `async` because the git2 adapter wraps blocking I/O in
/// `tokio::task::spawn_blocking`.  The trait takes `&self` so implementations
/// can hold shared state (e.g. a cached repo handle behind a lock).
#[async_trait]
pub trait GitRepositoryPort: Send + Sync {
  /// Retain the current managed-mirror ownership for all later native writers.
  /// Test adapters without native filesystem work may keep the default no-op.
  async fn retain_operation_guard(&self, _guard: Arc<dyn GitOperationGuard>) -> Result<(), GitError> {
    Ok(())
  }

  /// Authenticate to a remote without cloning or mutating it. When `branch`
  /// is present, success also proves that exact branch is advertised.
  async fn probe_remote(&self, url: &str, branch: Option<&str>, auth: &GitAuth) -> Result<GitRemoteProbe, GitError>;

  /// Clone a remote repository to a local path.
  async fn clone_repo(&self, url: &str, path: &Path, branch: &str, auth: &GitAuth) -> Result<(), GitError>;

  /// Clone complete branch history into a temporary operator-owned location.
  ///
  /// Production reconciliation overrides this method so reachability checks do
  /// not inherit the shallow mirror limit used by normal sync runs.
  async fn clone_repo_full(&self, url: &str, path: &Path, branch: &str, auth: &GitAuth) -> Result<(), GitError> {
    self.clone_repo(url, path, branch, auth).await
  }

  /// Open an existing local repository.
  async fn open_repo(&self, path: &Path) -> Result<(), GitError>;

  /// Inspect exact worktree, origin, branch and readable commit/tree identity.
  async fn repository_identity(&self) -> Result<GitRepositoryIdentity, GitError> {
    Err(GitError::Internal(
      "repository identity inspection is not implemented by this adapter".to_string(),
    ))
  }

  /// Fetch latest changes from remote.
  async fn fetch(&self, auth: &GitAuth) -> Result<(), GitError>;

  /// Checkout a specific branch.
  async fn checkout_branch(&self, branch: &str) -> Result<(), GitError>;

  /// Reset the local branch and worktree to its fetched remote-tracking ref,
  /// returning the verified resulting HEAD.
  async fn reset_to_remote(&self, branch: &str) -> Result<String, GitError>;

  /// Preserve a dirty managed working tree before normalization.
  async fn stash_if_dirty(&self) -> Result<bool, GitError> {
    Ok(false)
  }

  /// Remove recovery stashes after a completely successful sync.
  async fn drop_all_stashes(&self) -> Result<(), GitError> {
    Ok(())
  }

  /// Get the current HEAD commit OID as a hex string.
  async fn head_oid(&self) -> Result<String, GitError>;

  /// Return whether `ancestor_oid` is the same as or an ancestor of
  /// `descendant_oid` in the currently opened repository.
  async fn commit_is_ancestor(&self, ancestor_oid: &str, descendant_oid: &str) -> Result<bool, GitError> {
    let _ = (ancestor_oid, descendant_oid);
    Err(GitError::Internal(
      "commit reachability is not implemented by this repository adapter".to_string(),
    ))
  }

  /// Read the branch OID advertised by the authenticated remote.
  ///
  /// This is deliberately distinct from `head_oid`: a local tracking ref or
  /// worktree HEAD is not proof of current remote state.
  async fn remote_branch_oid(&self, branch: &str, auth: &GitAuth) -> Result<String, GitError>;

  /// List changed files between two commits (or HEAD vs working tree).
  ///
  /// - `from = None, to = None` — diff HEAD against working tree
  /// - `from = Some(oid), to = None` — diff oid..HEAD
  /// - `from = Some(oid), to = Some(oid)` — diff between two commits
  async fn changed_files(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<ChangedFile>, GitError>;

  /// Read a file's content from the working tree.
  async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError>;
  /// Read immutable receipt-owned bytes without changing the checked-out tree.
  /// Full-history callers must still verify ancestry and current path ownership.
  async fn read_file_at_revision(&self, _oid: &str, _path: &str) -> Result<Vec<u8>, GitError> {
    Err(GitError::Internal("immutable Git tree reads are unavailable".into()))
  }

  /// Write a file to the working tree (creates parent directories as needed).
  async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), GitError>;

  /// Delete a file from the working tree.
  async fn delete_file(&self, path: &str) -> Result<(), GitError>;

  /// Rename/move a file in the working tree.
  async fn rename_file(&self, from: &str, to: &str) -> Result<(), GitError>;

  /// Stage all changes and create a commit.  Returns the new commit OID.
  async fn commit(&self, message: &str, author_name: &str, author_email: &str) -> Result<String, GitError>;

  /// Push the intended local commit and verify the remote's advertised branch
  /// ref before returning success.
  async fn push(&self, branch: &str, intended_oid: &str, auth: &GitAuth) -> Result<GitPushReceipt, GitError>;
}

#[cfg(test)]
mod tests {
  use super::{HttpsCertificatePolicy, allows_https_credential_target};
  use std::collections::HashSet;

  #[test]
  fn https_certificate_policy_only_bypasses_for_explicit_allowed_host() {
    let allowed = HashSet::from(["git.example.test".to_string()]);

    assert!(HttpsCertificatePolicy::InsecureNoVerify.allows_invalid_certificate("GIT.EXAMPLE.TEST", &allowed));
    assert!(!HttpsCertificatePolicy::Strict.allows_invalid_certificate("git.example.test", &allowed));
    assert!(!HttpsCertificatePolicy::InsecureNoVerify.allows_invalid_certificate("redirect.example.test", &allowed));
    assert!(!HttpsCertificatePolicy::InsecureNoVerify.allows_invalid_certificate("git.example.test", &HashSet::new()));
  }

  #[test]
  fn https_credentials_are_bound_to_the_concrete_callback_target() {
    let allowed = HashSet::from(["git.example.test".to_string()]);

    assert!(allows_https_credential_target(
      "https://GIT.EXAMPLE.TEST:8443/repo.git",
      &allowed
    ));
    assert!(!allows_https_credential_target(
      "https://redirect.example.test/repo.git",
      &allowed
    ));
    assert!(!allows_https_credential_target(
      "https://user:secret@git.example.test/repo.git",
      &allowed
    ));
    assert!(!allows_https_credential_target(
      "http://git.example.test/repo.git",
      &allowed
    ));
    assert!(!allows_https_credential_target("not a URL", &allowed));
    assert!(allows_https_credential_target(
      "https://unrestricted.example.test/repo.git",
      &HashSet::new()
    ));
  }
}
